/** Pure pixel decoding for uncompressed DICOM image data. Returns real-valued intensities so volumes can be segmented. */

export type PixelSpec = {
  rows: number;
  cols: number;
  bitsAllocated: 8 | 16;
  /** 0 = unsigned, 1 = two's complement. */
  pixelRepresentation: 0 | 1;
  littleEndian: boolean;
  /** RescaleSlope / RescaleIntercept (0028,1053 / 0028,1052). Defaults 1 and 0 when the file has none. */
  slope?: number;
  intercept?: number;
  samplesPerPixel?: number;
};

export type DecodedPixels = { pixels: Float32Array; warnings: string[] };

export function decodePixels(bytes: Uint8Array, spec: PixelSpec): DecodedPixels {
  const warnings: string[] = [];
  if ((spec.samplesPerPixel ?? 1) !== 1) throw new Error("Only single-sample (grayscale) images are supported.");
  const n = spec.rows * spec.cols;
  const bytesPer = spec.bitsAllocated / 8;
  if (!Number.isInteger(bytesPer) || (bytesPer !== 1 && bytesPer !== 2)) throw new Error("Only 8- and 16-bit pixel data are supported.");
  if (bytes.length < n * bytesPer) throw new Error(`Pixel data holds ${bytes.length} bytes; ${n * bytesPer} are needed.`);
  const slope = spec.slope ?? 1;
  const intercept = spec.intercept ?? 0;
  if (spec.slope == null && spec.intercept == null) warnings.push("No rescale slope or intercept in the file; stored values were used as intensities.");
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i += 1) {
    let raw: number;
    if (bytesPer === 1) raw = spec.pixelRepresentation === 1 ? dv.getInt8(i) : dv.getUint8(i);
    else raw = spec.pixelRepresentation === 1 ? dv.getInt16(i * 2, spec.littleEndian) : dv.getUint16(i * 2, spec.littleEndian);
    out[i] = raw * slope + intercept;
  }
  return { pixels: out, warnings };
}
