/**
 * Plain-text and OCR extraction from report files: TXT, DOCX (Office Open XML),
 * native-text PDFs, and scanned/hybrid multi-page PDFs (Sprint 4 Task 2A & 2B).
 *
 * Key guarantees:
 * - Preserves document page numbers across multi-page PDFs.
 * - Detects per-page whether extractable native text exists; invokes OCR only on
 *   pages that contain scanned images without extractable native text.
 * - Never silently drops pages when a page fails extraction or OCR.
 * - Records whether extracted text came from `native_pdf_text`, `ocr_pdf`,
 *   `hybrid_pdf_text_and_ocr`, `docx_xml`, or `plain_text`.
 * - Never claims OCR accuracy without evaluation (`ocrAccuracyClaimed: false`).
 */
import { readZipEntry } from "./zip.ts";
import {
  defaultOcrPageRecognizer,
  type OcrPageRecognizer,
  type PdfPageExtraction,
} from "./ocr.ts";

export type ReportFileKind = "txt" | "docx" | "pdf";

export type ReportExtractionMethod =
  | "native_pdf_text"
  | "ocr_pdf"
  | "hybrid_pdf_text_and_ocr"
  | "docx_xml"
  | "plain_text";

export type TextResult = {
  kind: ReportFileKind;
  text: string;
  warnings: string[];
  /** Share of printable characters. Low values mean the decoder probably did not understand the file. */
  printableRatio: number;
  usable: boolean;
  isScanned?: boolean;
  imageCount?: number;
  pageCount: number;
  pages: PdfPageExtraction[];
  extractionMethod: ReportExtractionMethod;
  ocrUsed: boolean;
  ocrFailedPages: number[];
  ocrAccuracyClaimed: false;
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
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  )
    return "pdf";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
    return "zip-other";
  const head = bytes.subarray(0, 1024);
  for (const b of head) if (b === 0) return "unknown";
  return "txt";
}

export function printableRatio(text: string): number {
  if (!text.length) return 0;
  let ok = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      c === 9 ||
      c === 10 ||
      c === 13 ||
      (c >= 32 && c !== 127 && !(c >= 0x80 && c < 0xa0) && c !== 0xfffd)
    )
      ok += 1;
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
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)
    body = body.subarray(3);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), warnings };
  } catch {
    warnings.push("The file is not valid UTF-8; it was read as Latin-1. Check accented characters.");
    return { text: new TextDecoder("latin1").decode(body), warnings };
  }
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : m;
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
  for (const m of body.matchAll(re))
    parts.push(m[1] != null ? decodeXmlEntities(m[1]) : m[2]);
  return parts.join("");
}

export async function decodeDocx(bytes: Uint8Array): Promise<{ text: string; warnings: string[] }> {
  const xml = await readZipEntry(bytes, "word/document.xml");
  if (!xml)
    throw new Error("This ZIP file is not a Word document (word/document.xml is missing).");
  return {
    text: docxXmlToText(new TextDecoder().decode(xml)),
    warnings: ["Headers, footers, comments and text boxes in the Word file are not read."],
  };
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const buf = await new Response(stream).arrayBuffer();
  if (buf.byteLength > 50 * 1024 * 1024)
    throw new Error("PDF stream inflates beyond the size limit.");
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
      const map: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\",
      };
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
  for (let k = 0; k < hex.length; k += 2)
    out += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
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

export interface DecodePdfOptions {
  enableOcr?: boolean;
  ocrRecognizer?: OcrPageRecognizer;
}

export async function decodePdf(
  bytes: Uint8Array,
  options?: DecodePdfOptions,
): Promise<{
  text: string;
  warnings: string[];
  isScanned?: boolean;
  images?: number;
  pages: PdfPageExtraction[];
  pageCount: number;
  extractionMethod: ReportExtractionMethod;
  ocrUsed: boolean;
  ocrFailedPages: number[];
}> {
  const warnings: string[] = [];
  const raw = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\b/.test(raw)) throw new Error("Encrypted PDF files are not read.");

  const enableOcr = options?.enableOcr !== false;
  const recognizer = options?.ocrRecognizer ?? defaultOcrPageRecognizer;

  // Parse all PDF objects so we can associate streams with pages (or fall back to sequential stream order)
  const streamEntries: Array<{
    objId: number | null;
    dict: string;
    isImage: boolean;
    decodedBytes: Uint8Array | null;
    text: string;
    unsupportedFilter: boolean;
  }> = [];

  let unsupportedFilters = 0;
  let images = 0;
  const re = /(?:(\d+)\s+0\s+obj\s*)?<<((?:(?!>>\s*stream|endobj)[\s\S]){0,4000})>>\s*stream\r?\n/g;

  for (const m of raw.matchAll(re)) {
    const objId = m[1] ? Number.parseInt(m[1], 10) : null;
    const dict = m[2];
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;

    const isImage = /\/Subtype\s*\/Image/.test(dict);
    if (
      !isImage &&
      (/\/Type\s*\/(XRef|ObjStm|Metadata)/.test(dict) || /\/Length1|\/FontFile/.test(dict))
    ) {
      continue;
    }

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
    let unsupported = false;
    try {
      if (filters.length === 1 && filters[0] === "/FlateDecode") {
        data = await inflateZlib(data);
      } else if (filters.length > 0) {
        unsupported = true;
      }
    } catch {
      unsupported = true;
    }

    if (isImage) {
      images += 1;
      streamEntries.push({
        objId,
        dict,
        isImage: true,
        decodedBytes: unsupported ? null : data,
        text: "",
        unsupportedFilter: unsupported,
      });
      continue;
    }

    if (unsupported) {
      unsupportedFilters += 1;
      streamEntries.push({
        objId,
        dict,
        isImage: false,
        decodedBytes: null,
        text: "",
        unsupportedFilter: true,
      });
      continue;
    }

    const content = new TextDecoder("latin1").decode(data);
    const extracted = /\bBT\b/.test(content) ? normaliseWhitespace(textFromContentStream(content)) : "";
    streamEntries.push({
      objId,
      dict,
      isImage: false,
      decodedBytes: data,
      text: extracted,
      unsupportedFilter: false,
    });
  }

  // Group streams by /Type /Page objects when present
  const pageObjects: Array<{ pageNumber: number; contentRefs: number[]; rawDict: string }> = [];
  const pageObjRe = /(\d+)\s+0\s+obj\s*<<((?:(?!endobj)[\s\S]){0,3000})>>\s*endobj/g;
  for (const pm of raw.matchAll(pageObjRe)) {
    const dict = pm[2];
    if (!/\/Type\s*\/Page\b(?!s)/.test(dict)) continue;
    const refs: number[] = [];
    const contentsArrayMatch = /\/Contents\s*\[([^\]]+)\]/.exec(dict);
    if (contentsArrayMatch) {
      for (const rm of contentsArrayMatch[1].matchAll(/(\d+)\s+0\s+R/g)) {
        refs.push(Number.parseInt(rm[1], 10));
      }
    } else {
      const singleRef = /\/Contents\s+(\d+)\s+0\s+R/.exec(dict);
      if (singleRef) refs.push(Number.parseInt(singleRef[1], 10));
    }
    for (const xm of dict.matchAll(/\/Im\d*\s+(\d+)\s+0\s+R/g)) {
      refs.push(Number.parseInt(xm[1], 10));
    }
    pageObjects.push({
      pageNumber: pageObjects.length + 1,
      contentRefs: refs,
      rawDict: dict,
    });
  }

  const streamByObjId = new Map<number, (typeof streamEntries)[number]>();
  for (const se of streamEntries) {
    if (se.objId !== null) streamByObjId.set(se.objId, se);
  }

  const pages: PdfPageExtraction[] = [];
  let ocrUsed = false;
  const ocrFailedPages: number[] = [];

  if (pageObjects.length > 0 && pageObjects.some((p) => p.contentRefs.length > 0)) {
    for (const pObj of pageObjects) {
      const pageStreams = pObj.contentRefs
        .map((id) => streamByObjId.get(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));

      // If a single-page PDF has unreferenced image streams, attach them to page 1
      if (pageObjects.length === 1 && pageStreams.filter((s) => s.isImage).length === 0) {
        for (const se of streamEntries) {
          if (se.isImage && !pageStreams.includes(se)) {
            pageStreams.push(se);
          }
        }
      }

      const nativeTexts = pageStreams
        .filter((s) => !s.isImage && s.text.length > 0)
        .map((s) => s.text);
      const nativeText = normaliseWhitespace(nativeTexts.join("\n"));
      const imageStreams = pageStreams.filter((s) => s.isImage);
      const hasNativeText = nativeText.length >= 20;
      const hasImages = imageStreams.length > 0;
      const pageWarnings: string[] = [];

      if (hasNativeText) {
        pages.push({
          pageNumber: pObj.pageNumber,
          text: nativeText,
          source: "native_pdf_text",
          method: "native_pdf_text",
          hasNativeText: true,
          hasImages,
          imageCount: imageStreams.length,
          ocrAttempted: false,
          ocrFailed: false,
          confidence: 1.0,
          warnings: pageWarnings,
        });
      } else if (hasImages && enableOcr) {
        const imagePayloads = imageStreams
          .map((s) => s.decodedBytes)
          .filter((b): b is Uint8Array => b !== null);
        const ocrRes = await recognizer({
          pageNumber: pObj.pageNumber,
          imagePayloads,
          rawPageDictAndStreams:
            pObj.rawDict + "\n" + imageStreams.map((s) => s.dict).join("\n"),
        });
        if (ocrRes.warning) pageWarnings.push(ocrRes.warning);
        if ((ocrRes as { warnings?: string[] }).warnings) pageWarnings.push(...((ocrRes as { warnings?: string[] }).warnings ?? []));

        if (!ocrRes.failed && ocrRes.text.trim().length > 0) {
          ocrUsed = true;
          pages.push({
            pageNumber: pObj.pageNumber,
            text: normaliseWhitespace(ocrRes.text),
            source: "ocr",
            method: "ocr",
            hasNativeText: false,
            hasImages: true,
            imageCount: imageStreams.length,
            ocrAttempted: true,
            ocrFailed: false,
            confidence: ocrRes.confidence ?? null,
            warnings: pageWarnings,
          });
        } else {
          ocrFailedPages.push(pObj.pageNumber);
          warnings.push(`Page ${pObj.pageNumber}: OCR extraction failed or returned no readable text.`);
          pages.push({
            pageNumber: pObj.pageNumber,
            text: nativeText,
            source: "empty",
            method: "failed",
            hasNativeText: false,
            hasImages: true,
            imageCount: imageStreams.length,
            ocrAttempted: true,
            ocrFailed: true,
            confidence: null,
            warnings: pageWarnings,
          });
        }
      } else {
        if (!nativeText) {
          pageWarnings.push(`Page ${pObj.pageNumber}: No extractable text stream found on this page.`);
        }
        pages.push({
          pageNumber: pObj.pageNumber,
          text: nativeText,
          source: nativeText ? "native_pdf_text" : "empty",
          hasNativeText: Boolean(nativeText),
          hasImages,
          imageCount: imageStreams.length,
          ocrAttempted: false,
          ocrFailed: false,
          confidence: nativeText ? 1.0 : null,
          warnings: pageWarnings,
        });
      }
    }
  } else {
    // Fallback when PDF streams are not indexed via /Contents object references
    const textStreams = streamEntries.filter((s) => !s.isImage && s.text.length > 0);
    const imageStreams = streamEntries.filter((s) => s.isImage);
    const nativeText = normaliseWhitespace(textStreams.map((s) => s.text).join("\n"));

    if (nativeText.length >= 20) {
      pages.push({
        pageNumber: 1,
        text: nativeText,
        source: "native_pdf_text",
        hasNativeText: true,
        hasImages: imageStreams.length > 0,
        imageCount: imageStreams.length,
        ocrAttempted: false,
        ocrFailed: false,
        confidence: 1.0,
        warnings: [],
      });
    } else if (imageStreams.length > 0 && enableOcr) {
      // Treat each image stream as a scanned page if there are no page objects
      for (let idx = 0; idx < imageStreams.length; idx++) {
        const img = imageStreams[idx];
        const pageNum = idx + 1;
        const ocrRes = await recognizer({
          pageNumber: pageNum,
          imagePayloads: img.decodedBytes ? [img.decodedBytes] : [],
          rawPageDictAndStreams: img.dict,
        });
        const pageWarnings = ocrRes.warning ? [ocrRes.warning] : [];
        if (!ocrRes.failed && ocrRes.text.trim().length > 0) {
          ocrUsed = true;
          pages.push({
            pageNumber: pageNum,
            text: normaliseWhitespace(ocrRes.text),
            source: "ocr",
            method: "ocr",
            hasNativeText: false,
            hasImages: true,
            imageCount: 1,
            ocrAttempted: true,
            ocrFailed: false,
            confidence: ocrRes.confidence ?? null,
            warnings: pageWarnings,
          });
        } else {
          ocrFailedPages.push(pageNum);
          pages.push({
            pageNumber: pageNum,
            text: nativeText,
            source: "empty",
            hasNativeText: false,
            hasImages: true,
            imageCount: 1,
            ocrAttempted: true,
            ocrFailed: true,
            confidence: null,
            warnings: pageWarnings,
          });
        }
      }
    } else {
      pages.push({
        pageNumber: 1,
        text: nativeText,
        source: nativeText ? "native_pdf_text" : "empty",
        hasNativeText: Boolean(nativeText),
        hasImages: imageStreams.length > 0,
        imageCount: imageStreams.length,
        ocrAttempted: false,
        ocrFailed: false,
        confidence: nativeText ? 1.0 : null,
        warnings: [],
      });
    }
  }

  const hasNativePages = pages.some((p) => p.source === "native_pdf_text");
  const hasOcrPages = pages.some((p) => p.source === "ocr");
  const extractionMethod: ReportExtractionMethod =
    hasNativePages && hasOcrPages
      ? "hybrid_pdf_text_and_ocr"
      : hasOcrPages
        ? "ocr_pdf"
        : "native_pdf_text";

  // Combine page texts. For multi-page documents (>1 page), preserve page markers when helpful,
  // while keeping single-page native text byte-identical for existing offset tests.
  const nonEmptyPages = pages.filter((p) => p.text.trim().length > 0);
  const extractedText =
    pages.length === 1
      ? (pages[0]?.text ?? "")
      : nonEmptyPages
          .map((p) =>
            hasOcrPages || pages.length > 1 ? `[Page ${p.pageNumber}]\n${p.text}` : p.text,
          )
          .join("\n\n");

  const isScanned = images > 0 && !hasNativePages;
  if (isScanned && !ocrUsed) {
    warnings.push(
      "SCANNED PDF LIMITATION: This document contains image-only or scanned pages that could not be decoded by OCR. Please review the pages or provide a text-encoded report.",
    );
  }
  if (ocrUsed) {
    warnings.push(
      `OCR recovery used on ${pages.filter((p) => p.source === "ocr").length} of ${pages.length} page(s). OCR accuracy is not clinically validated; clinician review of extracted text is required.`,
    );
  }
  if (ocrFailedPages.length > 0) {
    warnings.push(
      `OCR could not decode ${ocrFailedPages.length} scanned page(s) (page ${ocrFailedPages.join(", ")}). Those pages were not dropped and are marked for manual review.`,
    );
  }
  if (images > 0 && !ocrUsed) {
    warnings.push(
      `${images} embedded image${images === 1 ? "" : "s"} skipped. Scanned pages are not read (no OCR).`,
    );
  }
  if (unsupportedFilters > 0) {
    warnings.push(
      `${unsupportedFilters} stream${unsupportedFilters === 1 ? "" : "s"} used an unsupported filter and were skipped.`,
    );
  }
  for (const p of pages) {
    for (const pw of p.warnings) {
      if (!warnings.includes(pw)) warnings.push(pw);
    }
  }
  warnings.push(
    "PDF text is read from simple content streams and page-level OCR fallback where needed. Fonts with custom encodings may come out garbled; check the preview.",
  );

  return {
    text: extractedText,
    warnings,
    isScanned,
    images,
    pages,
    pageCount: Math.max(1, pages.length),
    extractionMethod,
    ocrUsed,
    ocrFailedPages,
  };
}

/** Entry point. Refuses unknown or mismatched content instead of guessing. */
export async function extractReportText(
  name: string,
  bytes: Uint8Array,
  options?: DecodePdfOptions,
): Promise<TextResult> {
  if (bytes.length > MAX_REPORT_FILE_BYTES)
    throw new Error(`File is larger than ${MAX_REPORT_FILE_BYTES / 1024 / 1024} MB.`);
  const byName = kindFromName(name);
  if (!byName) throw new Error("Only .txt, .docx and .pdf reports are accepted.");
  const sniffed = sniffKind(bytes);
  const matches =
    (byName === "pdf" && sniffed === "pdf") ||
    (byName === "docx" && sniffed === "zip-other") ||
    (byName === "txt" && sniffed === "txt");
  if (!matches)
    throw new Error(
      `The file name says .${byName} but the content does not look like one. It was not parsed.`,
    );

  if (byName === "txt") {
    const decoded = decodeTxt(bytes);
    let text = normaliseWhitespace(decoded.text);
    const warnings = [...decoded.warnings];
    if (text.length > MAX_REPORT_TEXT_CHARS) {
      text = text.slice(0, MAX_REPORT_TEXT_CHARS);
      warnings.push(`Text was cut at ${MAX_REPORT_TEXT_CHARS} characters.`);
    }
    const ratio = printableRatio(text);
    const usable = text.length >= 20 && ratio >= 0.9;
    if (!usable)
      warnings.push(
        "Little readable text was recovered. The report cannot be used for extraction as it is.",
      );
    return {
      kind: "txt",
      text,
      warnings,
      printableRatio: Number(ratio.toFixed(3)),
      usable,
      isScanned: false,
      imageCount: 0,
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          text,
          source: text ? "native_pdf_text" : "empty",
          hasNativeText: Boolean(text),
          hasImages: false,
          imageCount: 0,
          ocrAttempted: false,
          ocrFailed: false,
          confidence: 1.0,
          warnings: [],
        },
      ],
      extractionMethod: "plain_text",
      ocrUsed: false,
      ocrFailedPages: [],
      ocrAccuracyClaimed: false,
    };
  }

  if (byName === "docx") {
    const decoded = await decodeDocx(bytes);
    let text = normaliseWhitespace(decoded.text);
    const warnings = [...decoded.warnings];
    if (text.length > MAX_REPORT_TEXT_CHARS) {
      text = text.slice(0, MAX_REPORT_TEXT_CHARS);
      warnings.push(`Text was cut at ${MAX_REPORT_TEXT_CHARS} characters.`);
    }
    const ratio = printableRatio(text);
    const usable = text.length >= 20 && ratio >= 0.9;
    if (!usable)
      warnings.push(
        "Little readable text was recovered. The report cannot be used for extraction as it is.",
      );
    return {
      kind: "docx",
      text,
      warnings,
      printableRatio: Number(ratio.toFixed(3)),
      usable,
      isScanned: false,
      imageCount: 0,
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          text,
          source: text ? "native_pdf_text" : "empty",
          hasNativeText: Boolean(text),
          hasImages: false,
          imageCount: 0,
          ocrAttempted: false,
          ocrFailed: false,
          confidence: 1.0,
          warnings: [],
        },
      ],
      extractionMethod: "docx_xml",
      ocrUsed: false,
      ocrFailedPages: [],
      ocrAccuracyClaimed: false,
    };
  }

  const decoded = await decodePdf(bytes, options);
  let text = normaliseWhitespace(decoded.text);
  const warnings = [...decoded.warnings];
  if (text.length > MAX_REPORT_TEXT_CHARS) {
    text = text.slice(0, MAX_REPORT_TEXT_CHARS);
    warnings.push(`Text was cut at ${MAX_REPORT_TEXT_CHARS} characters.`);
  }
  const ratio = printableRatio(text);
  const usable = text.length >= 20 && ratio >= 0.9;
  if (!usable)
    warnings.push(
      "Little readable text was recovered. The report cannot be used for extraction as it is.",
    );

  return {
    kind: "pdf",
    text,
    warnings,
    printableRatio: Number(ratio.toFixed(3)),
    usable,
    isScanned: Boolean(decoded.isScanned),
    imageCount: decoded.images ?? 0,
    pageCount: decoded.pageCount,
    pages: decoded.pages,
    extractionMethod: decoded.extractionMethod,
    ocrUsed: decoded.ocrUsed,
    ocrFailedPages: decoded.ocrFailedPages,
    ocrAccuracyClaimed: false,
  };
}
