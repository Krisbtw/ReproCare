/** Minimal explicit-VR little-endian DICOM Part 10 writer and a safe metadata reader. Pixels are not persisted server-side. */

const LONG_VR = new Set(["OB", "OW", "OF", "SQ", "UT", "UN", "UC", "UR", "OD", "OL", "OV"]);

export function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function padVr(vr: string, bytes: Uint8Array): Uint8Array {
  if (bytes.length % 2 === 0) return bytes;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = vr === "UI" ? 0 : 32;
  return out;
}

export function element(group: number, el: number, vr: string, value: string | Uint8Array): Uint8Array {
  const raw = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const data = padVr(vr, raw);
  const long = LONG_VR.has(vr);
  const out = new Uint8Array((long ? 12 : 8) + data.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, el, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  if (long) {
    view.setUint16(6, 0, true);
    view.setUint32(8, data.length, true);
  } else {
    view.setUint16(6, data.length, true);
  }
  out.set(data, long ? 12 : 8);
  return out;
}

export function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

export function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function buildSyntheticMrDicom(): Uint8Array {
  const rows = 32;
  const cols = 32;
  const pixels = new Uint8Array(rows * cols);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = (x - 15.5) / 9;
      const dy = (y - 16) / 6.5;
      pixels[y * cols + x] = dx * dx + dy * dy <= 1 ? 200 : 24;
    }
  }
  const sopClass = "1.2.840.10008.5.1.4.1.1.4";
  const sopInstance = "1.2.826.0.1.3680043.10.543.1";
  const studyUid = "1.2.826.0.1.3680043.10.543.2";
  const seriesUid = "1.2.826.0.1.3680043.10.543.3";
  const transfer = "1.2.840.10008.1.2.1";
  const impl = "1.2.826.0.1.3680043.10.543.9";
  const metaBody = concat([
    element(0x0002, 0x0001, "OB", Uint8Array.from([0, 1])),
    element(0x0002, 0x0002, "UI", sopClass),
    element(0x0002, 0x0003, "UI", sopInstance),
    element(0x0002, 0x0010, "UI", transfer),
    element(0x0002, 0x0012, "UI", impl),
  ]);
  const preamble = new Uint8Array(132);
  preamble.set(new TextEncoder().encode("DICM"), 128);
  return concat([
    preamble,
    element(0x0002, 0x0000, "UL", u32(metaBody.length)),
    metaBody,
    element(0x0008, 0x0016, "UI", sopClass),
    element(0x0008, 0x0018, "UI", sopInstance),
    element(0x0008, 0x0020, "DA", "20251102"),
    element(0x0008, 0x0060, "CS", "MR"),
    element(0x0008, 0x1030, "LO", "Synthetic phantom"),
    element(0x0008, 0x103e, "LO", "Sagittal T2 phantom"),
    element(0x0010, 0x0010, "PN", "SYNTHETIC^PHANTOM"),
    element(0x0010, 0x0020, "LO", "PHANTOM-ONLY"),
    element(0x0018, 0x0050, "DS", "4.0"),
    element(0x0018, 0x5100, "CS", "HFS"),
    element(0x0020, 0x000d, "UI", studyUid),
    element(0x0020, 0x000e, "UI", seriesUid),
    element(0x0020, 0x0013, "IS", "1"),
    element(0x0020, 0x0032, "DS", "0\\0\\0"),
    element(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
    element(0x0028, 0x0002, "US", u16(1)),
    element(0x0028, 0x0004, "CS", "MONOCHROME2"),
    element(0x0028, 0x0010, "US", u16(rows)),
    element(0x0028, 0x0011, "US", u16(cols)),
    element(0x0028, 0x0030, "DS", "1.2\\1.2"),
    element(0x0028, 0x0100, "US", u16(8)),
    element(0x0028, 0x0101, "US", u16(8)),
    element(0x0028, 0x0102, "US", u16(7)),
    element(0x0028, 0x0103, "US", u16(0)),
    element(0x7fe0, 0x0010, "OB", pixels),
  ]);
}

export type DicomRead = {
  metadata: Record<string, string>;
  warnings: string[];
  transferSyntax: string;
  renderable: boolean;
  rows: number;
  cols: number;
  pixels: Uint8ClampedArray | null;
  identifiersWithheld: boolean;
};

type ElementLike = { dataOffset: number; length: number; vr?: string };
export type DataSetLike = {
  string: (tag: string) => string | undefined;
  uint16: (tag: string) => number | undefined;
  elements: Record<string, ElementLike>;
  byteArray: Uint8Array;
};

const TAGS: [string, string][] = [
  ["x00080060", "Modality"],
  ["x00080020", "Study date"],
  ["x00080030", "Study time"],
  ["x00081030", "Study description"],
  ["x0008103e", "Series description"],
  ["x00180015", "Body part"],
  ["x00180050", "Slice thickness"],
  ["x00180088", "Spacing between slices"],
  ["x00185100", "Patient position"],
  ["x0020000d", "Study UID"],
  ["x0020000e", "Series UID"],
  ["x00200013", "Instance number"],
  ["x00200032", "Image position patient"],
  ["x00200037", "Image orientation patient"],
  ["x00280002", "Samples per pixel"],
  ["x00280004", "Photometric"],
  ["x00280010", "Rows"],
  ["x00280011", "Columns"],
  ["x00280030", "Pixel spacing"],
  ["x00280100", "Bits allocated"],
  ["x00280101", "Bits stored"],
  ["x00280103", "Pixel representation"],
  ["x00020010", "Transfer syntax"],
  ["x00080016", "SOP class"],
];

export function readDicom(byteArray: Uint8Array, parse: (b: Uint8Array) => DataSetLike): DicomRead {
  const data = parse(byteArray);
  const metadata: Record<string, string> = {};
  for (const [tag, label] of TAGS) {
    const value = data.string(tag);
    if (value) metadata[label] = value.replace(/\0/g, "").trim();
  }
  const warnings: string[] = [];
  if (!metadata["Pixel spacing"]) warnings.push("Pixel spacing is missing, so distances cannot be calibrated from this file.");
  if (!metadata["Image orientation patient"]) warnings.push("Image orientation is missing, so this slice cannot be placed in a volume.");
  if (!metadata["Image position patient"]) warnings.push("Image position is missing, so slice order in space cannot be checked.");
  const transfer = metadata["Transfer syntax"] ?? "";
  const uncompressed =
    transfer === "" ||
    transfer === "1.2.840.10008.1.2.1" ||
    transfer === "1.2.840.10008.1.2" ||
    transfer === "1.2.840.10008.1.2.2";
  if (transfer && !uncompressed) {
    warnings.push("Transfer syntax is compressed. Metadata was read; pixels were not decoded.");
  }
  const rows = data.uint16("x00280010") ?? 0;
  const cols = data.uint16("x00280011") ?? 0;
  const bits = data.uint16("x00280100") ?? 0;
  const photometric = metadata["Photometric"] ?? "";
  const pixelEl = data.elements.x7fe00010;
  let pixels: Uint8ClampedArray | null = null;
  let renderable = false;
  if (pixelEl && uncompressed && rows > 0 && cols > 0 && bits === 8 && rows * cols <= pixelEl.length) {
    const src = data.byteArray.subarray(pixelEl.dataOffset, pixelEl.dataOffset + rows * cols);
    pixels = new Uint8ClampedArray(rows * cols * 4);
    for (let i = 0; i < src.length; i += 1) {
      let v = src[i];
      if (photometric === "MONOCHROME1") v = 255 - v;
      pixels[i * 4] = v;
      pixels[i * 4 + 1] = v;
      pixels[i * 4 + 2] = v;
      pixels[i * 4 + 3] = 255;
    }
    renderable = true;
  } else if (pixelEl) {
    warnings.push("Pixel data is present but this viewer only draws uncompressed 8-bit grayscale. Metadata is still saved.");
  } else {
    warnings.push("No pixel data element was found.");
  }
  const hadName = Boolean(data.string("x00100010") || data.string("x00100020"));
  if (hadName) warnings.push("Patient name and ID from the header were read locally and are not stored.");
  return {
    metadata,
    warnings,
    transferSyntax: transfer,
    renderable,
    rows,
    cols,
    pixels,
    identifiersWithheld: true,
  };
}

export function metadataForStorage(read: DicomRead): string {
  return JSON.stringify({ metadata: read.metadata, renderable: read.renderable, rows: read.rows, cols: read.cols });
}

/** Loads dicom-parser without leaking its types into the UI. */
export async function loadDicomParser(): Promise<(b: Uint8Array) => DataSetLike> {
  const mod = (await import("dicom-parser")) as unknown as {
    parseDicom?: (b: Uint8Array) => DataSetLike;
    default?: { parseDicom: (b: Uint8Array) => DataSetLike };
  };
  const parse = mod.parseDicom ?? mod.default?.parseDicom;
  if (!parse) throw new Error("DICOM parser did not load.");
  return parse;
}

export async function readDicomBytes(bytes: Uint8Array): Promise<DicomRead> {
  return readDicom(bytes, await loadDicomParser());
}
