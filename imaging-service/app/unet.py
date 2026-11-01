"""Lightweight 3D U-Net implementation for UMD uterine myoma segmentation.
Can be instantiated with PyTorch and trained via train_umd.py or used with MONAI.
"""
from __future__ import annotations

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError:
    torch = None
    nn = object
    F = None


if torch is not None:

    class DoubleConv3D(nn.Module):
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

        def forward(self, x):
            return self.conv(x)

    class SimpleUnet3D(nn.Module):
        """Standard 3D U-Net for 5-class segmentation (0=background, 1=uterine_wall, 2=cavity, 3=myoma, 4=nabothian)."""

        def __init__(self, in_channels: int = 1, num_classes: int = 5, base_filters: int = 16):
            super().__init__()
            f = base_filters
            self.inc = DoubleConv3D(in_channels, f)
            self.down1 = nn.Sequential(nn.MaxPool3d(2), DoubleConv3D(f, f * 2))
            self.down2 = nn.Sequential(nn.MaxPool3d(2), DoubleConv3D(f * 2, f * 4))
            self.down3 = nn.Sequential(nn.MaxPool3d(2), DoubleConv3D(f * 4, f * 8))

            self.up1 = nn.ConvTranspose3d(f * 8, f * 4, kernel_size=2, stride=2)
            self.conv_up1 = DoubleConv3D(f * 8, f * 4)

            self.up2 = nn.ConvTranspose3d(f * 4, f * 2, kernel_size=2, stride=2)
            self.conv_up2 = DoubleConv3D(f * 4, f * 2)

            self.up3 = nn.ConvTranspose3d(f * 2, f, kernel_size=2, stride=2)
            self.conv_up3 = DoubleConv3D(f * 2, f)

            self.outc = nn.Conv3d(f, num_classes, kernel_size=1)

        def forward(self, x):
            x1 = self.inc(x)
            x2 = self.down1(x1)
            x3 = self.down2(x2)
            x4 = self.down3(x3)

            x = self.up1(x4)
            diffZ = x3.size()[2] - x.size()[2]
            diffY = x3.size()[3] - x.size()[3]
            diffX = x3.size()[4] - x.size()[4]
            x = F.pad(x, [diffX // 2, diffX - diffX // 2, diffY // 2, diffY - diffY // 2, diffZ // 2, diffZ - diffZ // 2])
            x = self.conv_up1(torch.cat([x3, x], dim=1))

            x = self.up2(x)
            diffZ = x2.size()[2] - x.size()[2]
            diffY = x2.size()[3] - x.size()[3]
            diffX = x2.size()[4] - x.size()[4]
            x = F.pad(x, [diffX // 2, diffX - diffX // 2, diffY // 2, diffY - diffY // 2, diffZ // 2, diffZ - diffZ // 2])
            x = self.conv_up2(torch.cat([x2, x], dim=1))

            x = self.up3(x)
            diffZ = x1.size()[2] - x.size()[2]
            diffY = x1.size()[3] - x.size()[3]
            diffX = x1.size()[4] - x.size()[4]
            x = F.pad(x, [diffX // 2, diffX - diffX // 2, diffY // 2, diffY - diffY // 2, diffZ // 2, diffZ - diffZ // 2])
            x = self.conv_up3(torch.cat([x1, x], dim=1))

            logits = self.outc(x)
            return logits

else:

    class SimpleUnet3D:  # type: ignore[no-redef]
        def __init__(self, *args, **kwargs):
            raise RuntimeError("PyTorch is required to instantiate SimpleUnet3D.")

