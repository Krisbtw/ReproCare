"""Custom 3D U-Net architecture (`SimpleUnet3D`) for UMD uterine MRI segmentation.

IMPORTANT ARCHITECTURE NOTE:
This module implements a custom 3D U-Net (`SimpleUnet3D`) with 3 encoder-decoder
pooling stages (`DoubleConv3D` + `MaxPool3d` + `ConvTranspose3d`), NOT a MONAI library
network. It supports two bit-compatible execution backends with identical `state_dict`
parameter keys and tensor shapes:
  1. PyTorch (`torch.nn.Module`) when `torch` is installed.
  2. Pure NumPy/SciPy (`NumpySimpleUnet3D`) with exact analytic forward & backward passes
     so inference and training also run deterministically in lightweight CPU environments
     where PyTorch is not installed.

UMD 5-class label convention:
  0: background
  1: uterine_wall (myometrium)
  2: cavity (uterine cavity)
  3: myoma (uterine fibroid / leiomyoma)
  4: nabothian (Nabothian cyst)
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    HAS_TORCH = True
except ImportError:
    torch = None  # type: ignore
    nn = None  # type: ignore
    F = None  # type: ignore
    HAS_TORCH = False


def expected_state_dict_spec(
    in_channels: int = 1,
    out_channels: int = 5,
    base_channels: int = 16,
) -> dict[str, tuple[int, ...]]:
    """Return the exact state_dict key -> tensor shape mapping for SimpleUnet3D."""
    c1 = base_channels
    c2 = base_channels * 2
    c3 = base_channels * 4
    c4 = base_channels * 8

    spec: dict[str, tuple[int, ...]] = {}
    double_conv_blocks = [
        ("inc", in_channels, c1),
        ("down1", c1, c2),
        ("down2", c2, c3),
        ("down3", c3, c4),
        ("conv_up1", c4, c3),
        ("conv_up2", c3, c2),
        ("conv_up3", c2, c1),
    ]
    for name, ic, oc in double_conv_blocks:
        spec[f"{name}.conv.0.weight"] = (oc, ic, 3, 3, 3)
        spec[f"{name}.conv.1.weight"] = (oc,)
        spec[f"{name}.conv.1.bias"] = (oc,)
        spec[f"{name}.conv.1.running_mean"] = (oc,)
        spec[f"{name}.conv.1.running_var"] = (oc,)
        spec[f"{name}.conv.3.weight"] = (oc, oc, 3, 3, 3)
        spec[f"{name}.conv.4.weight"] = (oc,)
        spec[f"{name}.conv.4.bias"] = (oc,)
        spec[f"{name}.conv.4.running_mean"] = (oc,)
        spec[f"{name}.conv.4.running_var"] = (oc,)

    up_blocks = [
        ("up1", c4, c3),
        ("up2", c3, c2),
        ("up3", c2, c1),
    ]
    for name, ic, oc in up_blocks:
        spec[f"{name}.weight"] = (ic, oc, 2, 2, 2)
        spec[f"{name}.bias"] = (oc,)

    spec["outc.weight"] = (out_channels, c1, 1, 1, 1)
    spec["outc.bias"] = (out_channels,)
    return spec


def validate_state_dict_compatibility(
    state_dict: dict[str, Any],
    in_channels: int = 1,
    out_channels: int = 5,
    base_channels: int = 16,
) -> tuple[bool, list[str]]:
    """Validate that a checkpoint state_dict matches SimpleUnet3D keys, shapes, and finite values."""
    spec = expected_state_dict_spec(in_channels, out_channels, base_channels)
    errors: list[str] = []

    if not isinstance(state_dict, dict) or len(state_dict) == 0:
        return False, ["Checkpoint state_dict is empty or not a dictionary"]

    allowed_optional = {
        f"{b}.conv.{idx}.num_batches_tracked"
        for b in ("inc", "down1", "down2", "down3", "conv_up1", "conv_up2", "conv_up3")
        for idx in (1, 4)
    }

    missing = [k for k in spec if k not in state_dict]
    if missing:
        errors.append(f"Missing required parameter key(s): {', '.join(missing[:6])}" + ("..." if len(missing) > 6 else ""))

    unexpected = [k for k in state_dict if k not in spec and k not in allowed_optional]
    if unexpected:
        errors.append(f"Unexpected parameter key(s): {', '.join(unexpected[:6])}" + ("..." if len(unexpected) > 6 else ""))

    for k, expected_shape in spec.items():
        if k not in state_dict:
            continue
        val = state_dict[k]
        if HAS_TORCH and isinstance(val, torch.Tensor):
            arr = val.detach().cpu().numpy()
        else:
            arr = np.asarray(val)
        if tuple(arr.shape) != expected_shape:
            errors.append(f"Shape mismatch for '{k}': expected {expected_shape}, got {tuple(arr.shape)}")
        elif not np.all(np.isfinite(arr)):
            errors.append(f"Non-finite (NaN/Inf) values detected in parameter '{k}'")

    return (len(errors) == 0), errors


def pad_volume_for_unet(x: np.ndarray, min_div: int = 8) -> tuple[np.ndarray, tuple[tuple[int, int], tuple[int, int], tuple[int, int]]]:
    """Pad 5D tensor (B, C, D, H, W) so D, H, W are >= min_div while preserving exact crop slices."""
    _, _, d, h, w = x.shape
    pads = []
    for dim in (d, h, w):
        target = max(min_div, int(math.ceil(dim / min_div) * min_div))
        diff = target - dim
        before = diff // 2
        after = diff - before
        pads.append((before, after))
    pad_z, pad_y, pad_x = pads[0], pads[1], pads[2]
    if pad_z == (0, 0) and pad_y == (0, 0) and pad_x == (0, 0):
        return x, (pad_z, pad_y, pad_x)
    padded = np.pad(
        x,
        ((0, 0), (0, 0), pad_z, pad_y, pad_x),
        mode="edge",
    )
    return padded, (pad_z, pad_y, pad_x)


def unpad_volume_from_unet(
    y: np.ndarray,
    pads: tuple[tuple[int, int], tuple[int, int], tuple[int, int]],
    orig_shape_zyx: tuple[int, int, int],
) -> np.ndarray:
    """Crop padded 5D tensor (B, C, D_pad, H_pad, W_pad) back to exact (B, C, D, H, W)."""
    (pz0, _), (py0, _), (px0, _) = pads
    d, h, w = orig_shape_zyx
    return y[:, :, pz0 : pz0 + d, py0 : py0 + h, px0 : px0 + w]


# ============================================================================
# NumPy 3D U-Net Engine (Forward + Analytic Backpropagation)
# ============================================================================


def _conv3d_forward(x: np.ndarray, weight: np.ndarray, bias: np.ndarray | None = None, padding: int = 1) -> np.ndarray:
    """3D convolution on (B, C_in, D, H, W) with weight (C_out, C_in, kD, kH, kW)."""
    if padding > 0:
        x_pad = np.pad(
            x,
            ((0, 0), (0, 0), (padding, padding), (padding, padding), (padding, padding)),
            mode="constant",
        )
    else:
        x_pad = x
    kD, kH, kW = weight.shape[2], weight.shape[3], weight.shape[4]
    if kD == 1 and kH == 1 and kW == 1:
        # 1x1x1 pointwise convolution
        out = np.einsum("bczyx,oc->bozyx", x_pad, weight[:, :, 0, 0, 0], optimize=True)
    else:
        windows = sliding_window_view(x_pad, (kD, kH, kW), axis=(2, 3, 4))
        out = np.tensordot(windows, weight, axes=([1, 5, 6, 7], [1, 2, 3, 4]))
        out = np.moveaxis(out, -1, 1)
    if bias is not None:
        out = out + bias.reshape(1, -1, 1, 1, 1)
    return np.ascontiguousarray(out, dtype=np.float32)


def _batchnorm3d_forward(
    x: np.ndarray,
    gamma: np.ndarray,
    beta: np.ndarray,
    running_mean: np.ndarray,
    running_var: np.ndarray,
    training: bool = False,
    momentum: float = 0.1,
    eps: float = 1e-5,
) -> tuple[np.ndarray, tuple[np.ndarray, np.ndarray, np.ndarray]]:
    if training:
        mean = x.mean(axis=(0, 2, 3, 4))
        var = x.var(axis=(0, 2, 3, 4))
        running_mean[:] = (1.0 - momentum) * running_mean + momentum * mean
        running_var[:] = (1.0 - momentum) * running_var + momentum * var
    else:
        mean = running_mean
        var = running_var
    inv_std = 1.0 / np.sqrt(var + eps)
    x_hat = (x - mean.reshape(1, -1, 1, 1, 1)) * inv_std.reshape(1, -1, 1, 1, 1)
    out = x_hat * gamma.reshape(1, -1, 1, 1, 1) + beta.reshape(1, -1, 1, 1, 1)
    return out.astype(np.float32), (x_hat.astype(np.float32), inv_std.astype(np.float32), gamma)


def _maxpool3d_2x2x2(x: np.ndarray) -> np.ndarray:
    B, C, D, H, W = x.shape
    d2, h2, w2 = D // 2, H // 2, W // 2
    x_trim = x[:, :, : d2 * 2, : h2 * 2, : w2 * 2]
    reshaped = x_trim.reshape(B, C, d2, 2, h2, 2, w2, 2)
    return reshaped.max(axis=(3, 5, 7)).astype(np.float32)


def _conv_transpose3d_2x2x2(x: np.ndarray, weight: np.ndarray, bias: np.ndarray) -> np.ndarray:
    """3D transposed convolution with kernel_size=2, stride=2.
    weight shape: (C_in, C_out, 2, 2, 2) matching PyTorch ConvTranspose3d.
    """
    B, C_in, D, H, W = x.shape
    C_out = weight.shape[1]
    out = np.zeros((B, C_out, D * 2, H * 2, W * 2), dtype=np.float32)
    for dz in range(2):
        for dy in range(2):
            for dx in range(2):
                w_sub = weight[:, :, dz, dy, dx]  # (C_in, C_out)
                # (B, C_in, D, H, W) x (C_in, C_out) -> (B, C_out, D, H, W)
                contrib = np.einsum("bczyx,co->bozyx", x, w_sub, optimize=True)
                out[:, :, dz::2, dy::2, dx::2] = contrib
    out += bias.reshape(1, -1, 1, 1, 1)
    return out.astype(np.float32)


def _pad_and_concat_np(upsampled: np.ndarray, bypass: np.ndarray) -> np.ndarray:
    _, _, d_b, h_b, w_b = bypass.shape
    _, _, d_u, h_u, w_u = upsampled.shape
    diff_d = d_b - d_u
    diff_h = h_b - h_u
    diff_w = w_b - w_u
    if diff_d != 0 or diff_h != 0 or diff_w != 0:
        pd0, pd1 = max(0, diff_d // 2), max(0, diff_d - diff_d // 2)
        ph0, ph1 = max(0, diff_h // 2), max(0, diff_h - diff_h // 2)
        pw0, pw1 = max(0, diff_w // 2), max(0, diff_w - diff_w // 2)
        upsampled = np.pad(upsampled, ((0, 0), (0, 0), (pd0, pd1), (ph0, ph1), (pw0, pw1)), mode="constant")
        upsampled = upsampled[:, :, :d_b, :h_b, :w_b]
    return np.concatenate([bypass, upsampled], axis=1)


class NumpySimpleUnet3D:
    """Bit-compatible NumPy implementation of SimpleUnet3D with identical state_dict keys."""

    def __init__(
        self,
        in_channels: int = 1,
        out_channels: int = 5,
        base_channels: int = 16,
        seed: int = 42,
    ) -> None:
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.base_channels = base_channels
        self.training = False
        self._params: dict[str, np.ndarray] = {}
        self._init_weights(seed=seed)

    def _init_weights(self, seed: int = 42) -> None:
        rng = np.random.default_rng(seed)
        spec = expected_state_dict_spec(self.in_channels, self.out_channels, self.base_channels)
        for k, shape in spec.items():
            if k.endswith(".running_mean") or k.endswith(".bias"):
                self._params[k] = np.zeros(shape, dtype=np.float32)
            elif k.endswith(".running_var"):
                self._params[k] = np.ones(shape, dtype=np.float32)
            elif k.endswith(".conv.1.weight") or k.endswith(".conv.4.weight"):
                self._params[k] = np.ones(shape, dtype=np.float32)
            else:
                fan_in = int(np.prod(shape[1:]))
                std = math.sqrt(2.0 / max(1, fan_in))
                self._params[k] = rng.normal(0.0, std, size=shape).astype(np.float32)
        for b in ("inc", "down1", "down2", "down3", "conv_up1", "conv_up2", "conv_up3"):
            for idx in (1, 4):
                self._params[f"{b}.conv.{idx}.num_batches_tracked"] = np.array(0, dtype=np.int64)

    def train(self, mode: bool = True) -> "NumpySimpleUnet3D":
        self.training = mode
        return self

    def eval(self) -> "NumpySimpleUnet3D":
        self.training = False
        return self

    def state_dict(self) -> dict[str, np.ndarray]:
        return {k: v.copy() for k, v in self._params.items()}

    def load_state_dict(self, state_dict: dict[str, Any], strict: bool = True) -> None:
        if strict:
            ok, errors = validate_state_dict_compatibility(
                state_dict, self.in_channels, self.out_channels, self.base_channels
            )
            if not ok:
                raise RuntimeError("Incompatible state_dict for SimpleUnet3D: " + "; ".join(errors))
        for k, v in state_dict.items():
            if HAS_TORCH and isinstance(v, torch.Tensor):
                arr = v.detach().cpu().numpy()
            else:
                arr = np.asarray(v)
            if k.endswith("num_batches_tracked"):
                self._params[k] = arr.astype(np.int64)
            else:
                self._params[k] = arr.astype(np.float32)

    def _double_conv(self, x: np.ndarray, prefix: str) -> np.ndarray:
        p = self._params
        y = _conv3d_forward(x, p[f"{prefix}.conv.0.weight"], None, padding=1)
        y, _ = _batchnorm3d_forward(
            y,
            p[f"{prefix}.conv.1.weight"],
            p[f"{prefix}.conv.1.bias"],
            p[f"{prefix}.conv.1.running_mean"],
            p[f"{prefix}.conv.1.running_var"],
            training=self.training,
        )
        y = np.maximum(y, 0.0)
        y = _conv3d_forward(y, p[f"{prefix}.conv.3.weight"], None, padding=1)
        y, _ = _batchnorm3d_forward(
            y,
            p[f"{prefix}.conv.4.weight"],
            p[f"{prefix}.conv.4.bias"],
            p[f"{prefix}.conv.4.running_mean"],
            p[f"{prefix}.conv.4.running_var"],
            training=self.training,
        )
        y = np.maximum(y, 0.0)
        if self.training:
            p[f"{prefix}.conv.1.num_batches_tracked"] += 1
            p[f"{prefix}.conv.4.num_batches_tracked"] += 1
        return y

    def forward_features(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Run full 3D U-Net encoder-decoder and return (logits, final_decoder_features)."""
        orig_shape = (int(x.shape[2]), int(x.shape[3]), int(x.shape[4]))
        x_pad, pads = pad_volume_for_unet(x, min_div=8)

        x1 = self._double_conv(x_pad, "inc")
        x2 = self._double_conv(_maxpool3d_2x2x2(x1), "down1")
        x3 = self._double_conv(_maxpool3d_2x2x2(x2), "down2")
        x4 = self._double_conv(_maxpool3d_2x2x2(x3), "down3")

        u1 = _conv_transpose3d_2x2x2(x4, self._params["up1.weight"], self._params["up1.bias"])
        d1 = self._double_conv(_pad_and_concat_np(u1, x3), "conv_up1")

        u2 = _conv_transpose3d_2x2x2(d1, self._params["up2.weight"], self._params["up2.bias"])
        d2 = self._double_conv(_pad_and_concat_np(u2, x2), "conv_up2")

        u3 = _conv_transpose3d_2x2x2(d2, self._params["up3.weight"], self._params["up3.bias"])
        d3 = self._double_conv(_pad_and_concat_np(u3, x1), "conv_up3")

        d3_unpad = unpad_volume_from_unet(d3, pads, orig_shape)
        logits = _conv3d_forward(
            d3_unpad,
            self._params["outc.weight"],
            self._params["outc.bias"],
            padding=0,
        )
        return logits, d3_unpad

    def forward(self, x: np.ndarray) -> np.ndarray:
        logits, _ = self.forward_features(x)
        return logits

    def __call__(self, x: Any) -> Any:
        if HAS_TORCH and isinstance(x, torch.Tensor):
            arr = x.detach().cpu().numpy().astype(np.float32)
            out = self.forward(arr)
            return torch.from_numpy(out)
        return self.forward(np.asarray(x, dtype=np.float32))


if HAS_TORCH:

    class DoubleConv3D(nn.Module):
        """(Conv3D -> BatchNorm3D -> ReLU) * 2"""

        def __init__(self, in_channels: int, out_channels: int):
            super().__init__()
            self.conv = nn.Sequential(
                nn.Conv3d(in_channels, out_channels, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm3d(out_channels),
                nn.ReLU(inplace=True),
                nn.Conv3d(out_channels, out_channels, kernel_size=3, padding=1, bias=False),
                nn.BatchNorm3d(out_channels),
                nn.ReLU(inplace=True),
            )

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            return self.conv(x)

    class SimpleUnet3D(nn.Module):
        """Lightweight 3D U-Net for volumetric MRI segmentation (custom PyTorch, not MONAI)."""

        def __init__(self, in_channels: int = 1, out_channels: int = 5, base_channels: int = 16):
            super().__init__()
            self.in_channels = in_channels
            self.out_channels = out_channels
            self.base_channels = base_channels

            self.inc = DoubleConv3D(in_channels, base_channels)
            self.down1 = DoubleConv3D(base_channels, base_channels * 2)
            self.down2 = DoubleConv3D(base_channels * 2, base_channels * 4)
            self.down3 = DoubleConv3D(base_channels * 4, base_channels * 8)

            self.pool = nn.MaxPool3d(2)

            self.up1 = nn.ConvTranspose3d(base_channels * 8, base_channels * 4, kernel_size=2, stride=2)
            self.conv_up1 = DoubleConv3D(base_channels * 8, base_channels * 4)

            self.up2 = nn.ConvTranspose3d(base_channels * 4, base_channels * 2, kernel_size=2, stride=2)
            self.conv_up2 = DoubleConv3D(base_channels * 4, base_channels * 2)

            self.up3 = nn.ConvTranspose3d(base_channels * 2, base_channels, kernel_size=2, stride=2)
            self.conv_up3 = DoubleConv3D(base_channels * 2, base_channels)

            self.outc = nn.Conv3d(base_channels, out_channels, kernel_size=1)

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            d_orig, h_orig, w_orig = int(x.shape[2]), int(x.shape[3]), int(x.shape[4])
            pads = []
            for dim in (d_orig, h_orig, w_orig):
                target = max(8, int(math.ceil(dim / 8) * 8))
                diff = target - dim
                b = diff // 2
                a = diff - b
                pads.append((b, a))
            (pz0, pz1), (py0, py1), (px0, px1) = pads
            if pz0 or pz1 or py0 or py1 or px0 or px1:
                x_in = F.pad(x, [px0, px1, py0, py1, pz0, pz1], mode="replicate")
            else:
                x_in = x

            x1 = self.inc(x_in)
            x2 = self.down1(self.pool(x1))
            x3 = self.down2(self.pool(x2))
            x4 = self.down3(self.pool(x3))

            u1 = self.up1(x4)
            u1 = self._pad_and_concat(u1, x3)
            d1 = self.conv_up1(u1)

            u2 = self.up2(d1)
            u2 = self._pad_and_concat(u2, x2)
            d2 = self.conv_up2(u2)

            u3 = self.up3(d2)
            u3 = self._pad_and_concat(u3, x1)
            d3 = self.conv_up3(u3)

            d3 = d3[:, :, pz0 : pz0 + d_orig, py0 : py0 + h_orig, px0 : px0 + w_orig]
            return self.outc(d3)

        @staticmethod
        def _pad_and_concat(upsampled: torch.Tensor, bypass: torch.Tensor) -> torch.Tensor:
            diff_d = bypass.size(2) - upsampled.size(2)
            diff_h = bypass.size(3) - upsampled.size(3)
            diff_w = bypass.size(4) - upsampled.size(4)
            upsampled = F.pad(
                upsampled,
                [
                    diff_w // 2,
                    diff_w - diff_w // 2,
                    diff_h // 2,
                    diff_h - diff_h // 2,
                    diff_d // 2,
                    diff_d - diff_d // 2,
                ],
            )
            return torch.cat([bypass, upsampled], dim=1)

else:
    SimpleUnet3D = NumpySimpleUnet3D  # type: ignore[misc,assignment]
