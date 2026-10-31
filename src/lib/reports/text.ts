/**
 * Plain-text extraction from report files: TXT, DOCX (Office Open XML) and simple text PDFs.
 *
 * Honest scope:
 * - TXT: UTF-8 (BOM removed). Latin-1 fallback when the bytes are not valid UTF-8.
 * - DOCX: word/document.xml paragraphs, tabs and breaks. Headers, footers, comments, text boxes and tracked
 *   deletions are not read.
 * - PDF: uncompressed or FlateDecode content streams, text-showing operators (Tj, TJ, ', ") with standard
 *   single-byte strings. Fonts with custom encodings (CID / ToUnicode maps) and scanned images are NOT decoded:
 *   there is no OCR. When little readable text comes out, the result says so and nothing is guessed.
 */
import { readZipEntry } from "./zip.ts";

export type ReportFileKind = "txt" | "docx" | "pdf";

export type TextResult = {
  kind: ReportFileKind;
  text: string;
  warnings: string[];
  /** Share of printable characters. Low values mean the decoder probably did not understand the file. */
  printableRatio: number;
  usable: boolean;
  isScanned?: boolean;
  imageCount?: number;
};

export const MAX_REPORT_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_REPORT_TEXT_CHARS = 60_000;

export function kindFromName(name: string): ReportFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".text")) return "txt";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

/** Content sniffing, so a renamed file is not parsed with the wrong reader. */
export function sniffKind(bytes: Uint8Array): ReportFileKind | "zip-other" | "unknown" {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip-other";
  // Binary heuristics: NUL bytes in the first KB mean it is not a text file.
  const head = bytes.subarray(0, 1024);
  for (const b of head) if (b === 0) return "unknown";
  return "txt";
}

export function printableRatio(text: string): number {
  if (!text.length) return 0;
  let ok = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && !(c >= 0x80 && c < 0xa0) && c !== 0xfffd)) ok += 1;
  }
  return ok / text.length;
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeTxt(bytes: Uint8Array): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), warnings };
  } catch {
    warnings.push("The file is not valid UTF-8; it was read as Latin-1. Check accented characters.");
    return { text: new TextDecoder("latin1").decode(body), warnings };
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** WordprocessingML body to text. Deleted runs (w:del) are dropped, so tracked deletions do not reappear. */
export function docxXmlToText(xml: string): string {
  const body = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");
  const parts: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\n|\t)/g;
  for (const m of body.matchAll(re)) parts.push(m[1] != null ? decodeXmlEntities(m[1]) : m[2]);
  return parts.join("");
}

export async function decodeDocx(bytes: Uint8Array): Promise<{ text: string; warnings: string[] }> {
  const xml = await readZipEntry(bytes, "word/document.xml");
  if (!xml) throw new Error("This ZIP file is not a Word document (word/document.xml is missing).");
  return {
    text: docxXmlToText(new TextDecoder().decode(xml)),
    warnings: ["Headers, footers, comments and text boxes in the Word file are not read."],
  };
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  const buf = await new Response(stream).arrayBuffer();
  if (buf.byteLength > 50 * 1024 * 1024) throw new Error("PDF stream inflates beyond the size limit.");
  return new Uint8Array(buf);
}

/** Parse a PDF literal string starting after "(" and return [decoded, indexAfterClosingParen]. */
function readLiteral(s: string, i: number): [string, number] {
  let depth = 1;
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (n in map) {
        out += map[n];
        i += 2;
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))![0];
        out += String.fromCharCode(parseInt(oct, 8));
        i += 1 + oct.length;
      } else if (n === "\n" || n === "\r") {
        i += n === "\r" && s[i + 2] === "\n" ? 3 : 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth === 0) return [out, i + 1];
    }
    out += c;
    i += 1;
  }
  return [out, i];
}

function readHex(s: string, i: number): [string, number] {
  const end = s.indexOf(">", i);
  const hex = s.slice(i, end < 0 ? s.length : end).replace(/\s+/g, "");
  let out = "";
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
  return [out, end < 0 ? s.length : end + 1];
}

/** Text-showing operators of one content stream, in drawing order. */
export function textFromContentStream(content: string): string {
  let out = "";
  let i = 0;
  let pending: string[] = [];
  let inText = false;
  while (i < content.length) {
    const c = content[i];
    if (c === "%") {
      const nl = content.indexOf("\n", i);
      i = nl < 0 ? content.length : nl + 1;
      continue;
    }
    if (c === "(") {
      const [str, next] = readLiteral(content, i + 1);
      pending.push(str);
      i = next;
      continue;
    }
    if (c === "<" && content[i + 1] !== "<") {
      const [str, next] = readHex(content, i + 1);
      pending.push(str);
      i = next;
      continue;
    }
    if (c === "[") {
      i += 1;
      continue;
    }
    if (c === "]") {
      i += 1;
      continue;
    }
    if (/[A-Za-z'"*]/.test(c)) {
      const m = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 4))!;
      const op = m[0];
      i += op.length;
      if (op === "BT") {
        inText = true;
        pending = [];
      } else if (op === "ET") {
        inText = false;
        if (!out.endsWith("\n")) out += "\n";
        pending = [];
      } else if (inText && (op === "Tj" || op === "TJ")) {
        out += pending.join("");
        pending = [];
      } else if (inText && (op === "'" || op === '"')) {
        out += `\n${pending.join("")}`;
        pending = [];
      } else if (inText && (op === "T*" || op === "Td" || op === "TD")) {
        if (out.length && !out.endsWith("\n")) out += "\n";
        pending = [];
      } else {
        pending = [];
      }
      continue;
    }
    if (c === "-" || c === "." || (c >= "0" && c <= "9")) {
      // A large negative kern inside TJ usually means a word space.
      const m = /^-?\d*\.?\d+/.exec(content.slice(i, i + 24));
      if (m) {
        if (inText && pending.length && Number(m[0]) < -180) pending.push(" ");
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export async function decodePdf(bytes: Uint8Array): Promise<{ text: string; warnings: string[]; isScanned?: boolean; images?: number }> {
  const warnings: string[] = [];
  const raw = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\b/.test(raw)) throw new Error("Encrypted PDF files are not read.");
  const texts: string[] = [];
  let unsupportedFilters = 0;
  let images = 0;
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,4000})>>\s*stream\r?\n/g;
  for (const m of raw.matchAll(re)) {
    const dict = m[1];
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    if (/\/Subtype\s*\/Image/.test(dict)) {
      images += 1;
      continue;
    }
    if (/\/Type\s*\/(XRef|ObjStm|Metadata)/.test(dict) || /\/Length1|\/FontFile/.test(dict)) continue;
    // Prefer a direct /Length; otherwise trim the end-of-line that precedes "endstream" (zlib rejects trailing bytes).
        const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
        let stop = end;
        if (declared && start + Number(declared[1]) <= end) stop = start + Number(declared[1]);
        else {
          if (bytes[stop - 1] === 0x0a) stop -= 1;
          if (bytes[stop - 1] === 0x0d) stop -= 1;
        }
        let data = bytes.subarray(start, stop);
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? "";
    const filters = filter.match(/\/\w+/g) ?? [];
    try {
      if (filters.length === 1 && filters[0] === "/FlateDecode") data = await inflateZlib(data);
      else if (filters.length > 0) {
        unsupportedFilters += 1;
        continue;
      }
    } catch {
      unsupportedFilters += 1;
      continue;
    }
    const content = new TextDecoder("latin1").decode(data);
    if (!/\bBT\b/.test(content)) continue;
    texts.push(textFromContentStream(content));
  }
  const extractedText = texts.join("\n");
  const isScanned = images > 0 && extractedText.trim().length < 80;
  if (isScanned) {
    warnings.push("SCANNED PDF LIMITATION: This document contains image-only or scanned pages. In-browser OCR is not supported; text could not be extracted automatically. Please upload a digital text-based PDF or paste text directly.");
  }
  if (images > 0) warnings.push(`${images} embedded image${images === 1 ? "" : "s"} skipped. Scanned pages are not read (no OCR).`);
  if (unsupportedFilters > 0) warnings.push(`${unsupportedFilters} stream${unsupportedFilters === 1 ? "" : "s"} used an unsupported filter and were skipped.`);
  warnings.push("PDF text is read from simple content streams only. Fonts with custom encodings may come out garbled; check the preview.");
  return { text: extractedText, warnings, isScanned, images };
}

/** Entry point. Refuses unknown or mismatched content instead of guessing. */
export async function extractReportText(name: string, bytes: Uint8Array): Promise<TextResult> {
  if (bytes.length > MAX_REPORT_FILE_BYTES) throw new Error(`File is larger than ${MAX_REPORT_FILE_BYTES / 1024 / 1024} MB.`);
  const byName = kindFromName(name);
  if (!byName) throw new Error("Only .txt, .docx and .pdf reports are accepted.");
  const sniffed = sniffKind(bytes);
  const matches = (byName === "pdf" && sniffed === "pdf") || (byName === "docx" && sniffed === "zip-other") || (byName === "txt" && sniffed === "txt");
  if (!matches) throw new Error(`The file name says .${byName} but the content does not look like one. It was not parsed.`);
  const decoded = byName === "txt" ? decodeTxt(bytes) : byName === "docx" ? await decodeDocx(bytes) : await decodePdf(bytes);
  let text = normaliseWhitespace(decoded.text);
  const warnings = [...decoded.warnings];
  if (text.length > MAX_REPORT_TEXT_CHARS) {
    text = text.slice(0, MAX_REPORT_TEXT_CHARS);
    warnings.push(`Text was cut at ${MAX_REPORT_TEXT_CHARS} characters.`);
  }
  const ratio = printableRatio(text);
  const usable = text.length >= 20 && ratio >= 0.9;
  if (!usable) warnings.push("Little readable text was recovered. The report cannot be used for extraction as it is.");
  const isScanned = Boolean((decoded as { isScanned?: boolean }).isScanned ?? (byName === "pdf" && text.length < 50 && decoded.warnings.some((w) => w.includes("embedded image"))));
  const imageCount = (decoded as { images?: number }).images ?? 0;
  return { kind: byName, text, warnings, printableRatio: Number(ratio.toFixed(3)), usable, isScanned, imageCount };
}
