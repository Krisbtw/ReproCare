/**
 * Builders for small but genuine DOCX (ZIP + WordprocessingML), native PDF,
 * multi-page PDF, and scanned-image PDF files, used by tests and by the
 * "synthetic sample report" buttons. Every byte is generated here; no real report is bundled.
 */
import { renderTextToGrayscaleRaster } from "./ocr.ts";

const enc = new TextEncoder();

function crc32(data: Uint8Array): number {
  let c = ~0 >>> 0;
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i];
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

async function compress(data: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function le(n: number, bytes: 2 | 4): Uint8Array {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) b[i] = (n >>> (8 * i)) & 0xff;
  return b;
}

/** ZIP with deflated (method 8) or stored (method 0) entries. */
export async function buildZip(
  entries: { name: string; data: Uint8Array; store?: boolean }[],
): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const method = e.store ? 0 : 8;
    const body = e.store ? e.data : await compress(e.data, "deflate-raw");
    const crc = crc32(e.data);
    const local = concat([
      le(0x04034b50, 4),
      le(20, 2),
      le(0, 2),
      le(method, 2),
      le(0, 2),
      le(0, 2),
      le(crc, 4),
      le(body.length, 4),
      le(e.data.length, 4),
      le(name.length, 2),
      le(0, 2),
      name,
      body,
    ]);
    centrals.push(
      concat([
        le(0x02014b50, 4),
        le(20, 2),
        le(20, 2),
        le(0, 2),
        le(method, 2),
        le(0, 2),
        le(0, 2),
        le(crc, 4),
        le(body.length, 4),
        le(e.data.length, 4),
        le(name.length, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 4),
        le(offset, 4),
        name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(centrals);
  const eocd = concat([
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(entries.length, 2),
    le(entries.length, 2),
    le(cd.length, 4),
    le(offset, 4),
    le(0, 2),
  ]);
  return concat([...locals, cd, eocd]);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function buildDocx(paragraphs: string[]): Promise<Uint8Array> {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  return buildZip([
    { name: "[Content_Types].xml", data: enc.encode(types), store: true },
    { name: "word/document.xml", data: enc.encode(doc) },
  ]);
}

function pdfString(s: string): string {
  return `(${s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

/** One-page PDF, Helvetica, one text line per entry. Content stream FlateDecode unless `uncompressed`. */
export async function buildPdf(
  lines: string[],
  opts: { uncompressed?: boolean } = {},
): Promise<Uint8Array> {
  const ops = ["BT", "/F1 11 Tf", "50 780 Td", "14 TL"];
  lines.forEach((l, i) => ops.push(i === 0 ? `${pdfString(l)} Tj` : `T* ${pdfString(l)} Tj`));
  ops.push("ET");
  const content = enc.encode(ops.join("\n"));
  const stream = opts.uncompressed ? content : await compress(content, "deflate");
  const filter = opts.uncompressed ? "" : " /Filter /FlateDecode";
  const objs: Uint8Array[] = [
    enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    enc.encode("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    enc.encode(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    ),
    concat([
      enc.encode(`4 0 obj\n<< /Length ${stream.length}${filter} >>\nstream\n`),
      stream,
      enc.encode("\nendstream\nendobj\n"),
    ]),
    enc.encode("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"),
  ];
  const header = enc.encode("%PDF-1.4\n");
  const offsets: number[] = [];
  let pos = header.length;
  for (const o of objs) {
    offsets.push(pos);
    pos += o.length;
  }
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  return concat([header, ...objs, enc.encode(xref)]);
}

export interface PdfPageSpec {
  mode: "native" | "native_text" | "scanned" | "scanned_image" | "corrupted_image";
  lines: string[];
}

/**
 * Build a multi-page PDF supporting any combination of native-text pages, scanned-image
 * pages (with genuine grayscale 5x7 glyph rasters), and corrupted-image pages.
 */
export async function buildMultiPagePdf(pages: PdfPageSpec[]): Promise<Uint8Array> {
  const objs: Uint8Array[] = [];
  // obj 1: Catalog, obj 2: Pages, obj 3: Font
  // For each page i (0..N-1): pageObjId = 4 + i*2, streamObjId = 5 + i*2
  const pageObjIds = pages.map((_, i) => 4 + i * 2);

  objs.push(enc.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  objs.push(
    enc.encode(
      `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`,
    ),
  );
  objs.push(
    enc.encode("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"),
  );

  for (let i = 0; i < pages.length; i++) {
    const spec = pages[i];
    const pageObjId = 4 + i * 2;
    const streamObjId = 5 + i * 2;

    if (spec.mode === "native_text" || spec.mode === "native") {
      const ops = ["BT", "/F1 11 Tf", "50 780 Td", "14 TL"];
      spec.lines.forEach((l, idx) =>
        ops.push(idx === 0 ? `${pdfString(l)} Tj` : `T* ${pdfString(l)} Tj`),
      );
      ops.push("ET");
      const content = enc.encode(ops.join("\n"));
      const compressed = await compress(content, "deflate");

      objs.push(
        enc.encode(
          `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamObjId} 0 R >>\nendobj\n`,
        ),
      );
      objs.push(
        concat([
          enc.encode(
            `${streamObjId} 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
          ),
          compressed,
          enc.encode("\nendstream\nendobj\n"),
        ]),
      );
    } else if (spec.mode === "scanned_image" || spec.mode === "scanned") {
      const raster = renderTextToGrayscaleRaster(spec.lines);
      const compressed = await compress(raster.pixels, "deflate");
      objs.push(
        enc.encode(
          `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 ${streamObjId} 0 R >> >> >>\nendobj\n`,
        ),
      );
      objs.push(
        concat([
          enc.encode(
            `${streamObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${raster.width} /Height ${raster.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
          ),
          compressed,
          enc.encode("\nendstream\nendobj\n"),
        ]),
      );
    } else {
      // corrupted_image: unreadable binary noise inside an Image XObject
      const noise = new Uint8Array([0x00, 0xff, 0x13, 0x37, 0xfa, 0xce, 0x00, 0x99]);
      objs.push(
        enc.encode(
          `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 ${streamObjId} 0 R >> >> >>\nendobj\n`,
        ),
      );
      objs.push(
        concat([
          enc.encode(
            `${streamObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${noise.length} >>\nstream\n`,
          ),
          noise,
          enc.encode("\nendstream\nendobj\n"),
        ]),
      );
    }
  }

  const header = enc.encode("%PDF-1.4\n");
  const offsets: number[] = [];
  let pos = header.length;
  for (const o of objs) {
    offsets.push(pos);
    pos += o.length;
  }
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  return concat([header, ...objs, enc.encode(xref)]);
}

/**
 * Convenience builder for a scanned PDF (1 or more pages of grayscale rasterized text).
 */
export async function buildScannedPdf(pagesLines: string[] | string[][]): Promise<Uint8Array> {
  const normalizedPages: string[][] =
    Array.isArray(pagesLines[0])
      ? (pagesLines as string[][])
      : [pagesLines as string[]];
  return buildMultiPagePdf(
    normalizedPages.map((lines) => ({ mode: "scanned_image" as const, lines })),
  );
}

/** Synthetic follow-up MRI report used by the demo button. Clearly fabricated. */
export const SAMPLE_REPORT_LINES = [
  "SYNTHETIC DEMONSTRATION REPORT - NOT A REAL PATIENT",
  "Patient Name: Synthetic Example",
  "MRN: SYN-000123",
  "Referred by: Dr. A. Example",
  "Examination: MRI pelvis with T2-weighted sagittal and axial sequences",
  "Exam date: 14/03/2026",
  "Findings: The uterus is enlarged. An intramural fibroid in the anterior wall measures 5.6 x 4.2 x 3.3 cm, FIGO 4.",
  "A second subserosal fibroid at the fundus measures 2.1 cm, FIGO 6.",
  "No endometrioma is seen. Both ovaries are normal in size.",
  "Impression: Multiple uterine fibroids as described.",
  "Recommend clinical correlation and follow-up imaging as clinically indicated.",
];
