/** Schematic sagittal stack from stored centroids. Not an MRI reconstruction. */

export type SliceMark = {
  id: string;
  slice: number | null;
  centroidMm: [number, number, number] | null;
  radiiMm: [number, number, number] | null;
  selected: boolean;
};

const PAPER = [243, 239, 230];
const INK = [27, 36, 47];
const PINE = [30, 74, 66];
const CLAY = [154, 70, 52];

function setPixel(buf: Uint8ClampedArray, w: number, x: number, y: number, rgb: number[], a: number) {
  if (x < 0 || y < 0 || x >= w) return;
  const h = buf.length / (w * 4);
  if (y >= h) return;
  const i = (y * w + x) * 4;
  const t = Math.max(0, Math.min(1, a));
  buf[i] = Math.round(buf[i] * (1 - t) + rgb[0] * t);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - t) + rgb[1] * t);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - t) + rgb[2] * t);
  buf[i + 3] = 255;
}

function fillEllipse(
  buf: Uint8ClampedArray,
  w: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rgb: number[],
  alpha: number,
) {
  const h = buf.length / (w * 4);
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPixel(buf, w, x, y, rgb, alpha);
    }
  }
}

/** How many slices a mark still appears on, from its stored radii. */
export function sliceReach(radiiMm: [number, number, number] | null): number {
  if (!radiiMm) return 1;
  return Math.max(1, Math.round(Math.max(...radiiMm) / 12));
}

export function markVisible(mark: SliceMark, currentSlice: number): boolean {
  if (mark.slice == null || !mark.centroidMm) return false;
  return Math.abs(mark.slice - currentSlice) <= sliceReach(mark.radiiMm);
}

/**
 * Draws one sagittal teaching slice.
 * Scene mapping matches the 3D stage (millimetres / 10) and is then fit to the canvas.
 */
export function drawSchematicSlice(
  width: number,
  height: number,
  currentSlice: number,
  marks: SliceMark[],
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = PAPER[0];
    buf[i + 1] = PAPER[1];
    buf[i + 2] = PAPER[2];
    buf[i + 3] = 255;
  }
  const cx = width * 0.48;
  const cy = height * 0.52;
  const uterusRx = width * 0.22;
  const uterusRy = height * 0.32;
  fillEllipse(buf, width, cx, cy, uterusRx, uterusRy, [214, 206, 192], 1);
  fillEllipse(buf, width, cx, cy, uterusRx * 0.72, uterusRy * 0.78, [186, 168, 150], 0.85);
  fillEllipse(buf, width, cx - uterusRx * 0.05, cy - uterusRy * 0.02, uterusRx * 0.18, uterusRy * 0.42, [120, 96, 86], 0.55);

  const pxPerUnit = Math.min(width, height) * 0.16;
  for (const mark of marks) {
    if (!markVisible(mark, currentSlice) || !mark.centroidMm) continue;
    const [mx, my, mz] = mark.centroidMm;
    const fade = 1 - Math.abs((mark.slice ?? currentSlice) - currentSlice) / (sliceReach(mark.radiiMm) + 1);
    const sx = cx + (mz / 10) * pxPerUnit * 0.85 + (mx / 10) * 4;
    const sy = cy - (my / 10) * pxPerUnit * 0.85;
    const rr = mark.radiiMm ?? ([12, 10, 10] as [number, number, number]);
    const rx = Math.max(6, Math.min(width * 0.16, (rr[0] / 20) * pxPerUnit * 0.55));
    const ry = Math.max(6, Math.min(height * 0.16, (rr[1] / 20) * pxPerUnit * 0.55));
    const rgb = mark.selected ? CLAY : PINE;
    fillEllipse(buf, width, sx, sy, rx, ry, rgb, 0.35 + 0.55 * fade);
    if (mark.selected) {
      for (let d = -8; d <= 8; d += 1) {
        setPixel(buf, width, Math.round(sx + d), Math.round(sy), INK, 0.8);
        setPixel(buf, width, Math.round(sx), Math.round(sy + d), INK, 0.8);
      }
    }
  }
  return buf;
}
