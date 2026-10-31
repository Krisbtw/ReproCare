/** Synthetic multi-slice, 16-bit DICOM series for tests and the Volume Lab sample. Every pixel is synthetic. */
import { concat, element, u16, u32 } from "./codec.ts";

export type SyntheticSeriesSpec = {
  cols: number;
  rows: number;
  slices: number;
  pixelSpacingMm: [number, number];
  sliceStepMm: number;
  /** Ellipsoid "lesion" radii in mm, centred in the volume. */
  lesionRadiiMm: [number, number, number];
  /** Slice indices to leave out, to simulate a missing slice. */
  dropSlices?: number[];
  seriesUid?: string;
  /** Peak deterministic pseudo-random noise added to every voxel, in intensity units. Default 0 (none). */
  noise?: number;
  /** Series description written to the header. */
  description?: string;
};

/** Small seeded generator so a noisy synthetic series is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOT = "1.2.826.0.1.3680043.10.543";

export function buildSyntheticSeries(spec: SyntheticSeriesSpec): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const seriesUid = spec.seriesUid ?? `${ROOT}.200`;
  const cx = ((spec.cols - 1) / 2) * spec.pixelSpacingMm[1];
  const cy = ((spec.rows - 1) / 2) * spec.pixelSpacingMm[0];
  const cz = ((spec.slices - 1) / 2) * spec.sliceStepMm;
  const slope = 2;
  const intercept = -100;
  const rand = mulberry32(12345);
  const noise = spec.noise ?? 0;
  for (let k = 0; k < spec.slices; k += 1) {
    if (spec.dropSlices?.includes(k)) continue;
    const px = new Uint8Array(spec.rows * spec.cols * 2);
    const dv = new DataView(px.buffer);
    for (let y = 0; y < spec.rows; y += 1) {
      for (let x = 0; x < spec.cols; x += 1) {
        const dx = (x * spec.pixelSpacingMm[1] - cx) / spec.lesionRadiiMm[0];
        const dy = (y * spec.pixelSpacingMm[0] - cy) / spec.lesionRadiiMm[1];
        const dz = (k * spec.sliceStepMm - cz) / spec.lesionRadiiMm[2];
        const inside = dx * dx + dy * dy + dz * dz <= 1;
        // Stored value = (real intensity - intercept) / slope, so real intensity is 400 inside and 100 outside.
        const real = (inside ? 400 : 100) + (noise > 0 ? (rand() * 2 - 1) * noise : 0);
        dv.setUint16((y * spec.cols + x) * 2, Math.max(0, Math.round((real - intercept) / slope)), true);
      }
    }
    const sopClass = "1.2.840.10008.5.1.4.1.1.4";
    const sopInstance = `${ROOT}.${1000 + k}`;
    const metaBody = concat([
      element(0x0002, 0x0001, "OB", Uint8Array.from([0, 1])),
      element(0x0002, 0x0002, "UI", sopClass),
      element(0x0002, 0x0003, "UI", sopInstance),
      element(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1"),
      element(0x0002, 0x0012, "UI", `${ROOT}.9`),
    ]);
    const preamble = new Uint8Array(132);
    preamble.set(new TextEncoder().encode("DICM"), 128);
    const z = k * spec.sliceStepMm;
    out.push({
      name: `synthetic-slice-${String(k + 1).padStart(3, "0")}.dcm`,
      bytes: concat([
        preamble,
        element(0x0002, 0x0000, "UL", u32(metaBody.length)),
        metaBody,
        element(0x0008, 0x0016, "UI", sopClass),
        element(0x0008, 0x0018, "UI", sopInstance),
        element(0x0008, 0x0020, "DA", "20251102"),
        element(0x0008, 0x0060, "CS", "MR"),
        element(0x0008, 0x103e, "LO", spec.description ?? "Synthetic sagittal T2 series"),
        element(0x0010, 0x0010, "PN", "SYNTHETIC^SERIES"),
        element(0x0010, 0x0020, "LO", "SERIES-ONLY"),
        element(0x0018, 0x0050, "DS", String(spec.sliceStepMm)),
        element(0x0020, 0x000d, "UI", `${ROOT}.100`),
        element(0x0020, 0x000e, "UI", seriesUid),
        element(0x0020, 0x0013, "IS", String(k + 1)),
        element(0x0020, 0x0032, "DS", `0\\0\\${z}`),
        element(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
        element(0x0028, 0x0002, "US", u16(1)),
        element(0x0028, 0x0004, "CS", "MONOCHROME2"),
        element(0x0028, 0x0010, "US", u16(spec.rows)),
        element(0x0028, 0x0011, "US", u16(spec.cols)),
        element(0x0028, 0x0030, "DS", `${spec.pixelSpacingMm[0]}\\${spec.pixelSpacingMm[1]}`),
        element(0x0028, 0x0100, "US", u16(16)),
        element(0x0028, 0x0101, "US", u16(16)),
        element(0x0028, 0x0102, "US", u16(15)),
        element(0x0028, 0x0103, "US", u16(0)),
        element(0x0028, 0x1052, "DS", String(intercept)),
        element(0x0028, 0x1053, "DS", String(slope)),
        element(0x7fe0, 0x0010, "OW", px),
      ]),
    });
  }
  return out;
}
