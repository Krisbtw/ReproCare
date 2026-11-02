/**
 * Deterministic 5x7 bitmap font table and grayscale raster generator & recognizer.
 * Browser-safe: zero native or Node.js dependencies.
 */

export const GLYPH_5X7: Record<string, [number, number, number, number, number, number, number]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 12, 4, 8],
  ":": [0, 12, 12, 0, 12, 12, 0],
  ";": [0, 12, 12, 0, 12, 4, 8],
  "-": [0, 0, 0, 31, 0, 0, 0],
  "/": [1, 2, 2, 4, 8, 8, 16],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  "x": [0, 0, 17, 10, 4, 10, 17],
};

/**
 * Render lines of text into a grayscale 8-bit raster image buffer with a small header
 * (`RCR1`, width u16be, height u16be, lineCount u16be, colsPerLine u16be, followed by
 * 8-bit grayscale pixels where 255 = foreground ink, 0 = background).
 * Used to build genuine multi-page raster image streams inside synthetic scanned PDFs.
 */
export function renderTextToGrayscaleRaster(lines: string[]): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  const normalizedLines = lines.map((l) => l.replace(/\r/g, ""));
  const maxCols = Math.max(1, ...normalizedLines.map((l) => l.length));
  const cellW = 6; // 5 glyph pixels + 1 spacing
  const cellH = 9; // 7 glyph pixels + 1 case-bit row + 1 spacing
  const width = maxCols * cellW;
  const height = Math.max(1, normalizedLines.length) * cellH;
  const headerSize = 12;
  const pixels = new Uint8Array(headerSize + width * height);

  // Header magic "RCR1" + geometry so the raster scanner knows exact cell pitch
  pixels[0] = 0x52; // 'R'
  pixels[1] = 0x43; // 'C'
  pixels[2] = 0x52; // 'R'
  pixels[3] = 0x31; // '1'
  const view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  view.setUint16(4, width, false);
  view.setUint16(6, height, false);
  view.setUint16(8, normalizedLines.length, false);
  view.setUint16(10, maxCols, false);

  for (let rowIdx = 0; rowIdx < normalizedLines.length; rowIdx++) {
    const line = normalizedLines[rowIdx];
    for (let colIdx = 0; colIdx < line.length; colIdx++) {
      const ch = line[colIdx];
      const upper = ch.toUpperCase();
      const isLower = ch >= "a" && ch <= "z" && ch !== "x";
      const glyph = GLYPH_5X7[ch] ?? GLYPH_5X7[upper] ?? GLYPH_5X7[" "];
      const baseX = colIdx * cellW;
      const baseY = rowIdx * cellH;

      for (let gy = 0; gy < 7; gy++) {
        const bits = glyph[gy];
        for (let gx = 0; gx < 5; gx++) {
          if ((bits >> (4 - gx)) & 1) {
            const px = baseX + gx;
            const py = baseY + gy;
            pixels[headerSize + py * width + px] = 255;
          }
        }
      }
      // Encode lowercase indicator in row 7 col 0 pixel
      if (isLower) {
        pixels[headerSize + (baseY + 7) * width + baseX] = 255;
      }
    }
  }

  return { width, height, pixels };
}

/**
 * Recognize text from a grayscale raster image buffer using 5x7 glyph template matching.
 */
export function recognizeGrayscaleRaster(pixels: Uint8Array): {
  recognized: boolean;
  text: string;
  confidence: number;
} {
  const headerSize = 12;
  if (
    pixels.length < headerSize ||
    pixels[0] !== 0x52 || // 'R'
    pixels[1] !== 0x43 || // 'C'
    pixels[2] !== 0x52 || // 'R'
    pixels[3] !== 0x31    // '1'
  ) {
    return { recognized: false, text: "", confidence: 0 };
  }

  const view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const width = view.getUint16(4, false);
  const height = view.getUint16(6, false);
  const lineCount = view.getUint16(8, false);
  const colsPerLine = view.getUint16(10, false);

  if (width <= 0 || height <= 0 || lineCount <= 0 || colsPerLine <= 0) {
    return { recognized: false, text: "", confidence: 0 };
  }

  const cellW = 6;
  const cellH = 9;
  const recoveredLines: string[] = [];
  let totalMatches = 0;
  let totalChars = 0;

  for (let rowIdx = 0; rowIdx < lineCount; rowIdx++) {
    let lineStr = "";
    for (let colIdx = 0; colIdx < colsPerLine; colIdx++) {
      const baseX = colIdx * cellW;
      const baseY = rowIdx * cellH;
      if (baseX + 5 > width || baseY + 7 > height) break;

      // Extract 7 rows of 5 bits
      let bestChar = " ";
      let minDiff = 35; // 7 * 5 max difference

      // Check lowercase flag in row 7 col 0
      const isLowerPixel =
        baseY + 7 < height ? pixels[headerSize + (baseY + 7) * width + baseX] > 128 : false;

      for (const [candidateChar, pattern] of Object.entries(GLYPH_5X7)) {
        let diff = 0;
        for (let gy = 0; gy < 7; gy++) {
          const expectedBits = pattern[gy];
          for (let gx = 0; gx < 5; gx++) {
            const expectedOn = ((expectedBits >> (4 - gx)) & 1) === 1;
            const actualOn = pixels[headerSize + (baseY + gy) * width + (baseX + gx)] > 128;
            if (expectedOn !== actualOn) diff += 1;
          }
        }
        if (diff < minDiff) {
          minDiff = diff;
          bestChar = candidateChar;
          if (diff === 0) break;
        }
      }

      if (minDiff <= 3) {
        totalMatches += 1;
        let charToAdd = bestChar;
        if (isLowerPixel && bestChar >= "A" && bestChar <= "Z") {
          charToAdd = bestChar.toLowerCase();
        }
        lineStr += charToAdd;
      } else {
        lineStr += " ";
      }
      totalChars += 1;
    }
    recoveredLines.push(lineStr.trimEnd());
  }

  const confidence = totalChars > 0 ? Number((totalMatches / totalChars).toFixed(2)) : 0;
  return {
    recognized: true,
    text: recoveredLines.join("\n").trim(),
    confidence,
  };
}
