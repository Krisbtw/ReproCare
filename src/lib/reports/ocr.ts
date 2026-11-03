function getNodeSpawnSync(): ((command: string, args?: readonly string[], options?: any) => any) | null {
  if (typeof window !== "undefined") return null;
  if (typeof process === "undefined" || !process.versions || !process.versions.node) return null;
  try {
    if (typeof (process as any).getBuiltinModule === "function") {
      const cp = (process as any).getBuiltinModule("node:child_process");
      if (cp && typeof cp.spawnSync === "function") return cp.spawnSync;
    }
  } catch (_) {}
  return null;
}

/**
 * Searches standard execution paths for the Tesseract binary across Linux, macOS, and Windows.
 */
export function resolveTesseractBinary(
  spawnSync?: ((command: string, args?: readonly string[], options?: any) => any) | null,
): string | null {
  const runner = spawnSync ?? getNodeSpawnSync();
  if (!runner) return null;

  if (typeof process !== "undefined" && process.env?.TESSERACT_PATH) {
    try {
      const res = runner(process.env.TESSERACT_PATH, ["--version"], { timeout: 2000 });
      if (res.status === 0) return process.env.TESSERACT_PATH;
    } catch (_) {}
  }

  // Check default PATH binary
  try {
    const res = runner("tesseract", ["--version"], { timeout: 2000 });
    if (res.status === 0) return "tesseract";
  } catch (_) {}

  const isWin = typeof process !== "undefined" && process.platform === "win32";
  const candidatePaths: string[] = isWin
    ? [
        "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
        "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe",
        `${process.env?.LOCALAPPDATA || ""}\\Programs\\Tesseract-OCR\\tesseract.exe`,
      ]
    : [
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/opt/homebrew/bin/tesseract",
      ];

  for (const cand of candidatePaths) {
    if (!cand) continue;
    try {
      const res = runner(cand, ["--version"], { timeout: 2000 });
      if (res.status === 0) return cand;
    } catch (_) {}
  }

  return null;
}

/**
 * Checks whether an image payload starts with a standard PNG, JPEG, TIFF, BMP, or Netpbm (P4/P5/P6) header
 * and runs local `/usr/bin/tesseract` OCR when available.
 * Never claims handwriting recognition (`handwritingSupported: false`).
 */
export interface OcrRuntimeCapabilities {
  tesseractInstalled: boolean;
  tesseractPath: string | null;
  tesseractVersion: string | null;
  englishTrainedDataAvailable: boolean;
  handwritingSupported: false;
  ocrAccuracyClaimed: false;
  warning: string | null;
}

/**
 * Inspect whether `/usr/bin/tesseract` (and the `eng` traineddata language pack)
 * is installed in the current container/host runtime.
 */
export function checkOcrRuntimeCapabilities(): OcrRuntimeCapabilities {
  const spawnSync = getNodeSpawnSync();

  if (!spawnSync) {
    return {
      tesseractInstalled: false,
      tesseractPath: null,
      tesseractVersion: null,
      englishTrainedDataAvailable: false,
      handwritingSupported: false,
      ocrAccuracyClaimed: false,
      warning:
        "tesseract-ocr is not available in the current browser/serverless environment; scanned PDF/image OCR will fall back to embedded PDF text and bitmap glyph layers.",
    };
  }

  const tessBin = resolveTesseractBinary(spawnSync);
  if (!tessBin) {
    return {
      tesseractInstalled: false,
      tesseractPath: null,
      tesseractVersion: null,
      englishTrainedDataAvailable: false,
      handwritingSupported: false,
      ocrAccuracyClaimed: false,
      warning:
        "tesseract-ocr binary is not installed in the runtime environment; scanned PDF/image OCR will fall back to embedded PDF text and bitmap glyph layers only.",
    };
  }

  try {
    const verRes = spawnSync(tessBin, ["--version"], { timeout: 3000 });
    if (verRes.status !== 0) {
      return {
        tesseractInstalled: false,
        tesseractPath: null,
        tesseractVersion: null,
        englishTrainedDataAvailable: false,
        handwritingSupported: false,
        ocrAccuracyClaimed: false,
        warning:
          "tesseract-ocr binary execution failed; scanned PDF/image OCR will fall back to embedded PDF text and bitmap glyph layers only.",
      };
    }
    const verOut = (verRes.stdout?.toString("utf8") || verRes.stderr?.toString("utf8") || "").trim();
    const firstLine = verOut.split(/\r?\n/)[0]?.trim() || "tesseract";
    const langRes = spawnSync(tessBin, ["--list-langs"], { timeout: 3000 });
    const langOut = (langRes.stdout?.toString("utf8") || langRes.stderr?.toString("utf8") || "").toLowerCase();
    const hasEng = langOut.includes("eng");
    return {
      tesseractInstalled: true,
      tesseractPath: tessBin,
      tesseractVersion: firstLine,
      englishTrainedDataAvailable: hasEng,
      handwritingSupported: false,
      ocrAccuracyClaimed: false,
      warning: hasEng
        ? null
        : "tesseract-ocr is installed but English language pack (tesseract-ocr-eng) was not detected.",
    };
  } catch {
    return {
      tesseractInstalled: false,
      tesseractPath: null,
      tesseractVersion: null,
      englishTrainedDataAvailable: false,
      handwritingSupported: false,
      ocrAccuracyClaimed: false,
      warning:
        "tesseract-ocr binary is not available in the current runtime environment; install tesseract-ocr and tesseract-ocr-eng for scanned image OCR.",
    };
  }
}

export interface OcrWordToken {
  text: string;
  confidence: number;
  bbox?: { left: number; top: number; width: number; height: number };
  lineNum?: number;
}

export interface ImageOcrResult {
  recognized: boolean;
  text: string;
  confidence: number | null;
  engine: "tesseract_cli" | "unavailable";
  handwritingSupported: false;
  words?: OcrWordToken[];
  warning?: string | null;
}

export function recognizeImageWithTesseract(imgBytes: Uint8Array): ImageOcrResult {
  if (!imgBytes || imgBytes.byteLength < 16) {
    return { recognized: false, text: "", confidence: null, engine: "unavailable", handwritingSupported: false };
  }
  const isPng = imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes[2] === 0x4e && imgBytes[3] === 0x47;
  const isJpeg = imgBytes[0] === 0xff && imgBytes[1] === 0xd8;
  const isTiff =
    (imgBytes[0] === 0x49 && imgBytes[1] === 0x49 && imgBytes[2] === 0x2a && imgBytes[3] === 0x00) ||
    (imgBytes[0] === 0x4d && imgBytes[1] === 0x4d && imgBytes[2] === 0x00 && imgBytes[3] === 0x2a);
  const isBmp = imgBytes[0] === 0x42 && imgBytes[1] === 0x4d;
  const isPnm = imgBytes[0] === 0x50 && (imgBytes[1] === 0x34 || imgBytes[1] === 0x35 || imgBytes[1] === 0x36);

  if (!isPng && !isJpeg && !isTiff && !isBmp && !isPnm) {
    return { recognized: false, text: "", confidence: null, engine: "unavailable", handwritingSupported: false };
  }

  const spawnSync = getNodeSpawnSync();
  if (!spawnSync) {
    return { recognized: false, text: "", confidence: null, engine: "unavailable", handwritingSupported: false };
  }

  const tessBin = resolveTesseractBinary(spawnSync);
  if (!tessBin) {
    return { recognized: false, text: "", confidence: null, engine: "unavailable", handwritingSupported: false };
  }

  try {
    // Request TSV output from Tesseract to calculate actual word-level and document confidence
    const res = spawnSync(tessBin, ["stdin", "stdout", "--psm", "6", "-l", "eng", "tsv"], {
      input: Buffer.from(imgBytes.buffer, imgBytes.byteOffset, imgBytes.byteLength),
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.status === 0 && res.stdout) {
      const rawTsv = res.stdout.toString("utf8");
      const lines = rawTsv.split(/\r?\n/);
      const words: OcrWordToken[] = [];
      const linesMap = new Map<number, string[]>();

      for (const line of lines) {
        if (!line.trim()) continue;
        const cols = line.split("\t");
        // TSV level 5 corresponds to word tokens
        if (cols.length >= 12 && cols[0].trim() === "5") {
          const wText = cols.slice(11).join("\t").trim();
          const confVal = parseFloat(cols[10]);
          if (wText.length > 0) {
            const left = parseInt(cols[6], 10) || 0;
            const top = parseInt(cols[7], 10) || 0;
            const width = parseInt(cols[8], 10) || 0;
            const height = parseInt(cols[9], 10) || 0;
            const lineNum = parseInt(cols[4], 10) || 1;

            if (!linesMap.has(lineNum)) linesMap.set(lineNum, []);
            linesMap.get(lineNum)!.push(wText);

            // Tesseract reports -1 for tokens without measurable confidence
            if (!isNaN(confVal) && confVal >= 0) {
              words.push({
                text: wText,
                confidence: Math.min(1.0, Math.max(0.0, confVal / 100)),
                bbox: { left, top, width, height },
                lineNum,
              });
            }
          }
        }
      }

      const reconstructedText = Array.from(linesMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, wordsInLine]) => wordsInLine.join(" "))
        .join("\n")
        .trim();

      if (reconstructedText.length >= 3) {
        const meanConfidence =
          words.length > 0
            ? Number((words.reduce((sum, w) => sum + w.confidence, 0) / words.length).toFixed(3))
            : null;

        return {
          recognized: true,
          text: reconstructedText,
          confidence: meanConfidence,
          engine: "tesseract_cli",
          handwritingSupported: false,
          words,
          warning:
            "Optical recognition confidence is an optical measurement and does not imply clinical validity or verification.",
        };
      }
    }
  } catch {
    // Fall through if tesseract execution fails
  }
  return { recognized: false, text: "", confidence: null, engine: "unavailable", handwritingSupported: false };
}

/**
 * Page-aware OCR and scanned-PDF text recovery (Sprint 4 Task 2B).
 *
 * Design & Scientific Integrity:
 * - Detects per-page whether a PDF page contains extractable native text streams vs
 *   scanned/image-based content.
 * - Runs OCR only on pages that lack extractable native text (`nativeText.length < 30`
 *   when image XObjects or raster streams are present).
 * - Preserves document page numbers (`1..N`) and never silently drops pages: if a page
 *   cannot be decoded or OCR fails, the page entry is retained with `ocrFailed: true`
 *   and an explicit warning for clinician review.
 * - Supports deterministic 5x7 bitmap glyph recognition on uncompressed/FlateDecode
 *   grayscale raster streams (` ReproCare-OCR-Raster `) and PDF `/ActualText` / OCR layer
 *   streams, as well as an optional pluggable OCR provider callback.
 * - Never claims unvalidated OCR accuracy (`ocrAccuracyClaimed: false`,
 *   `requiresClinicianReview: true`).
 */

export type PageExtractionSource = "native_pdf_text" | "ocr" | "empty";

export interface PdfPageExtraction {
  pageNumber: number;
  text: string;
  source: PageExtractionSource;
  hasNativeText: boolean;
  hasImages: boolean;
  imageCount: number;
  ocrAttempted: boolean;
  ocrFailed: boolean;
  confidence: number | null;
  warnings: string[];
  method?: string;
}

export interface PdfDocumentExtractionResult {
  pages: PdfPageExtraction[];
  pageCount: number;
  combinedText: string;
  extractionMethod: "native_pdf_text" | "ocr_pdf" | "hybrid_pdf_text_and_ocr";
  ocrUsed: boolean;
  ocrFailedPages: number[];
  ocrAccuracyClaimed: false;
  requiresClinicianReview: boolean;
  warnings: string[];
  method?: string;
}

export type OcrPageRecognizer = (input: {
  pageNumber: number;
  imagePayloads: Uint8Array[];
  rawPageDictAndStreams: string;
}) => Promise<{ text: string; confidence?: number | null; failed?: boolean; warning?: string }>;

export { GLYPH_5X7, renderTextToGrayscaleRaster, recognizeGrayscaleRaster } from "./raster.ts";
import { recognizeGrayscaleRaster } from "./raster.ts";

/**
 * Default page OCR recognizer that inspects embedded image streams in a scanned PDF page:
 * 1. Checks grayscale raster glyph streams (`recognizeGrayscaleRaster`).
 * 2. Checks embedded `/ActualText` or `/OCRText` annotations if present on the image XObject.
 * 3. If image bytes are corrupted or unintelligible binary noise, returns `failed: true`
 *    without inventing or guessing any clinical text.
 */
export const defaultOcrPageRecognizer: OcrPageRecognizer = async ({
  pageNumber,
  imagePayloads,
  rawPageDictAndStreams,
}) => {
  const recognizedParts: string[] = [];
  let totalConfidence = 0;
  let count = 0;

  for (const imgBytes of imagePayloads) {
    const rasterRes = recognizeGrayscaleRaster(imgBytes);
    if (rasterRes.recognized && rasterRes.text) {
      recognizedParts.push(rasterRes.text);
      totalConfidence += rasterRes.confidence;
      count += 1;
      continue;
    }
    const tessRes = recognizeImageWithTesseract(imgBytes);
    if (tessRes.recognized && tessRes.text) {
      recognizedParts.push(tessRes.text);
      if (tessRes.confidence != null) {
        totalConfidence += tessRes.confidence;
        count += 1;
      }
    }
  }

  if (recognizedParts.length === 0) {
    // Check if the PDF image dictionary carries an /ActualText (...) or /Alt (...) accessibility/OCR layer
    const actualMatches = rawPageDictAndStreams.matchAll(/\/(?:ActualText|Alt)\s*\(([^)]{3,2000})\)/g);
    for (const m of actualMatches) {
      const cleaned = m[1].replace(/\\n/g, "\n").replace(/\\([()\\])/g, "$1").trim();
      if (cleaned) {
        recognizedParts.push(cleaned);
        // Note: accessibility layer text carries unmeasured confidence
      }
    }
  }

  if (recognizedParts.length === 0) {
    return {
      text: "",
      confidence: null,
      failed: true,
      warning: `Page ${pageNumber}: Scanned image stream could not be decoded into readable text by OCR. Page was preserved as empty and requires manual clinician review.`,
    };
  }

  return {
    text: recognizedParts.join("\n").trim(),
    confidence: count > 0 ? Number((totalConfidence / count).toFixed(3)) : null,
    failed: false,
    warning: `Page ${pageNumber}: Text was recovered via OCR from a scanned image stream (unvalidated OCR heuristic — requires clinician verification against the original report). Optical recognition confidence does not imply clinical validity.`,
  };
};
