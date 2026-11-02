/**
 * DICOM PS3.15 Basic Application Level Confidentiality Profile De-Identification,
 * Deterministic UID Remapping, Recursive Sequence & Private-Tag Scrubbing, and
 * Burned-In Pixel Identifier Detection (Sprint 6 Task 2E & 2F).
 *
 * Key Guarantees:
 * 1. Original-File Preservation: Always allocates a new derived buffer; the caller's
 *    original Uint8Array / Buffer is NEVER mutated in place.
 * 2. Standard Identifying Tags (PS3.15 Table E.1-1): Scrubs/replaces Patient (0010,*),
 *    Institution/Physician/Operator/Station/Accession (0008,*), Device/Protocol (0018,*),
 *    StudyID/ImageComments (0020,*), Study/Visit/Procedure (0032,*, 0038,*, 0040,*).
 * 3. Private Tags (Odd Group Numbers, e.g., 0009,xxxx, 0019,xxxx, 0029,xxxx):
 *    Completely removes or zeroes odd-group private tags while preserving PixelData (7fe0,0010).
 * 4. Nested Sequences (VR === 'SQ'): Recursively traverses sequence items (FFFE,E000) to
 *    scrub nested identifying tags, remove nested private tags, and remap nested UIDs while
 *    preserving SharedFunctionalGroupsSequence (5200,9229) and
 *    PerFrameFunctionalGroupsSequence (5200,9230) spatial geometry tags.
 * 5. Consistent UID Remapping: Uses HMAC-SHA256 with a configurable salt so that
 *    StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID, FrameOfReferenceUID, and
 *    ReferencedSOPInstanceUID are replaced with valid NEMA PS3.5 `2.25.<decimal>` UIDs while
 *    keeping related studies, series, and frames of reference linkable.
 * 6. Geometry Preservation: Never modifies ImagePositionPatient (0020,0032),
 *    ImageOrientationPatient (0020,0037), PixelSpacing (0028,0030), SliceThickness (0018,0050),
 *    SpacingBetweenSlices (0018,0088), PatientPosition (0018,5100), Rows, Columns, or
 *    RescaleSlope / RescaleIntercept.
 * 7. Burned-In Identifier Detection & Honesty: Inspects header tags (BurnedInAnnotation 0028,0301,
 *    RecognizableVisualFeatures 0028,0302, Modality, ImageType, SOPClassUID) AND scans top/bottom
 *    pixel border bands for high-contrast burned-in text/glyph overlays. Never claims complete
 *    anonymisation from metadata removal alone (`claimCompleteAnonymisation: false`) and sets
 *    `manualReviewRequired: true` whenever burned-in risk is detected.
 */

import { createHash, createHmac } from "node:crypto";

export interface DicomDeidentifyOptions {
  /** Secret or session salt for deterministic UID remapping across a study/series. */
  uidSalt?: string;
  /** Deterministic day offset applied to StudyDate/SeriesDate/AcquisitionDate/ContentDate. */
  dateShiftDays?: number;
  /** Pseudonymous replacement token for PatientID (0010,0020). */
  patientIdReplacement?: string;
  /** Pseudonymous replacement token for PatientName (0010,0010). */
  patientNameReplacement?: string;
  /** Backwards-compatible alias for patientIdReplacement/patientNameReplacement. */
  pseudonymId?: string;
  /** Optional decoded first-frame pixel intensities (rows * cols) for pixel-border burned-in text detection. */
  decodedPixels?: Float32Array | Uint8Array | Uint8ClampedArray | null;
  rows?: number;
  cols?: number;
}

export type DicomDeidentificationOptions = DicomDeidentifyOptions;
export type DeidentificationOptions = DicomDeidentifyOptions;

export interface BurnedInPixelAnnotationReport {
  burnedInAnnotationHeaderFlag: string | null;
  recognizableVisualFeaturesFlag: string | null;
  highContrastBorderRatio: number;
  borderEdgeDensity: number;
  suspectedBurnedInTextRegions: string[];
  burnedInAnnotationDetected: boolean;
  riskLevel: "low" | "moderate" | "high";
  warning: string | null;
  reasons: string[];
}

export interface DicomDeidentificationResult {
  derivedBytes: Uint8Array;
  originalSha256: string;
  derivedSha256: string;
  originalPreserved: boolean;
  originalByteLength: number;
  derivedByteLength: number;
   originalBufferUnchanged: boolean;
  standardTagsScrubbed: string[];
  privateTagsRemoved: string[];
  nestedSequenceTagsScrubbed: string[];
  datesShifted: Record<string, { originalMask: string; shiftedTo: string }>;
  datesModified: string[];
  uidRemappingTable: Record<string, string>;
  uidRemappings: Record<string, string>;
  geometryPreserved: {
    imagePositionPatient: number[] | null;
    imageOrientationPatient: number[] | null;
    pixelSpacingMm: [number, number] | null;
    sliceThicknessMm: number | null;
    spacingBetweenSlicesMm: number | null;
    patientPosition: string | null;
  };
  preservedGeometryTags: Record<string, string>;
  burnedInReport: BurnedInPixelAnnotationReport;
  burnedInAnnotationRisk: "none" | "moderate" | "high";
  burnedInReasons: string[];
  pixelBorderTextSuspected: boolean;
  manualReviewRequired: boolean;
  claimCompleteAnonymisation: false;
  profileApplied: "DICOM_PS3.15_Basic_Application_Level_Confidentiality_Profile";
  anonymisationStatus:
    | "metadata_deidentified_pixel_clean"
    | "metadata_deidentified_manual_pixel_review_required";
  auditNotice: string;
}

export type DicomDeidentificationReport = DicomDeidentificationResult;
export type DeidentificationResult = DicomDeidentificationResult;

/**
 * Standard DICOM PS3.15 Basic Application Level Confidentiality Profile identifying tags.
 */
const IDENTIFYING_TAGS_ACTION: Record<string, "empty" | "replace_anon" | "shift_date" | "scrub_time"> = {
  // Patient Module (0010,xxxx)
  "0010,0010": "replace_anon", // PatientName
  "0010,0020": "replace_anon", // PatientID
  "0010,0021": "empty", // IssuerOfPatientID
  "0010,0030": "empty", // PatientBirthDate
  "0010,0032": "empty", // PatientBirthTime
  "0010,0040": "empty", // PatientSex
  "0010,1000": "empty", // OtherPatientIDs
  "0010,1001": "empty", // OtherPatientNames
  "0010,1005": "empty", // PatientBirthName
  "0010,1010": "empty", // PatientAge
  "0010,1020": "empty", // PatientSize
  "0010,1030": "empty", // PatientWeight
  "0010,1040": "empty", // PatientAddress
  "0010,1060": "empty", // PatientMotherBirthName
  "0010,1080": "empty", // MilitaryRank
  "0010,1081": "empty", // BranchOfService
  "0010,1090": "empty", // MedicalRecordLocator
  "0010,2154": "empty", // PatientTelephoneNumbers
  "0010,2160": "empty", // EthnicGroup
  "0010,2180": "empty", // Occupation
  "0010,21b0": "empty", // AdditionalPatientHistory
  "0010,4000": "empty", // PatientComments
  // General Study / Institution / Physician / Operator / Accession (0008,xxxx)
  "0008,0020": "shift_date", // StudyDate
  "0008,0021": "shift_date", // SeriesDate
  "0008,0022": "shift_date", // AcquisitionDate
  "0008,0023": "shift_date", // ContentDate
  "0008,0030": "scrub_time", // StudyTime
  "0008,0031": "scrub_time", // SeriesTime
  "0008,0032": "scrub_time", // AcquisitionTime
  "0008,0033": "scrub_time", // ContentTime
  "0008,0050": "empty", // AccessionNumber
  "0008,0080": "empty", // InstitutionName
  "0008,0081": "empty", // InstitutionAddress
  "0008,0082": "empty", // InstitutionCodeSequence
  "0008,0090": "empty", // ReferringPhysicianName
  "0008,0092": "empty", // ReferringPhysicianAddress
  "0008,0094": "empty", // ReferringPhysicianTelephoneNumbers
  "0008,1010": "empty", // StationName
  "0008,1030": "replace_anon", // StudyDescription
  "0008,103e": "replace_anon", // SeriesDescription
  "0008,1040": "empty", // InstitutionalDepartmentName
  "0008,1048": "empty", // PhysiciansOfRecord
  "0008,1050": "empty", // PerformingPhysicianName
  "0008,1060": "empty", // NameOfPhysiciansReadingStudy
  "0008,1070": "empty", // OperatorsName
  "0008,1080": "empty", // AdmittingDiagnosesDescription
  "0008,2111": "empty", // DerivationDescription
  "0008,4000": "empty", // IdentifyingComments
  // Device & Protocol (0018,xxxx)
  "0018,1000": "empty", // DeviceSerialNumber
  "0018,1030": "replace_anon", // ProtocolName
  // Study / Series / Synchronisation (0020,xxxx)
  "0020,0010": "replace_anon", // StudyID
  "0020,4000": "empty", // ImageComments
  // Study / Visit / Procedure (0032,xxxx, 0038,xxxx, 0040,xxxx)
  "0032,1032": "empty", // RequestingPhysician
  "0032,1033": "empty", // RequestingService
  "0038,0010": "empty", // AdmissionID
  "0038,0060": "empty", // ServiceEpisodeID
  "0040,0006": "empty", // ScheduledPerformingPhysicianName
  "0040,0010": "empty", // ScheduledStationAETitle
  "0040,0241": "empty", // PerformedStationAETitle
  "0040,0242": "empty", // PerformedStationName
  "0040,0243": "empty", // PerformedLocation
  "0040,0244": "shift_date", // PerformedProcedureStepStartDate
  "0040,0245": "scrub_time", // PerformedProcedureStepStartTime
  "0040,0253": "empty", // PerformedProcedureStepID
  "0040,0254": "empty", // PerformedProcedureStepDescription
  "0040,a123": "empty", // PersonName
};

/**
 * UID tags that must be deterministically remapped (preserving study/series/instance
 * linkage across slices while scrubbing original hospital/scanner UIDs).
 * Note: TransferSyntaxUID (0002,0010) and SOPClassUID (0008,0016 / 0002,0002) are
 * standard NEMA class identifiers and MUST NOT be remapped.
 */
const REMAP_UID_TAGS = new Set<string>([
  "0002,0003", // MediaStorageSOPInstanceUID
  "0008,0018", // SOPInstanceUID
  "0008,1155", // ReferencedSOPInstanceUID
  "0020,000d", // StudyInstanceUID
  "0020,000e", // SeriesInstanceUID
  "0020,0052", // FrameOfReferenceUID
  "0020,0200", // SynchronizationFrameOfReferenceUID
]);

const GEOMETRY_TAGS_TO_PRESERVE = new Set<string>([
  "0018,0050", // SliceThickness
  "0018,0088", // SpacingBetweenSlices
  "0018,5100", // PatientPosition
  "0020,0013", // InstanceNumber
  "0020,0032", // ImagePositionPatient
  "0020,0037", // ImageOrientationPatient
  "0028,0008", // NumberOfFrames
  "0028,0010", // Rows
  "0028,0011", // Columns
  "0028,0030", // PixelSpacing
  "0028,0100", // BitsAllocated
  "0028,0101", // BitsStored
  "0028,0102", // HighBit
  "0028,0103", // PixelRepresentation
  "0028,1050", // WindowCenter
  "0028,1051", // WindowWidth
  "0028,1052", // RescaleIntercept
  "0028,1053", // RescaleSlope
  "3004,000c", // GridFrameOffsetVector
]);

const LONG_VRS = new Set([
  "OB",
  "OD",
  "OF",
  "OL",
  "OW",
  "SQ",
  "UC",
  "UR",
  "UT",
  "UN",
  "OV",
]);

/**
 * Deterministically remaps a DICOM UID to a valid `2.25.<decimal>` UUID-derived UID
 * (<= 64 chars) using HMAC-SHA256 so that slices belonging to the same StudyInstanceUID
 * or SeriesInstanceUID always map to the exact same de-identified UID.
 */
export function remapDicomUid(
  originalUid: string,
  salt: string = "reprocare-ps315-default-salt",
): string {
  const clean = originalUid.replace(/\0/g, "").trim();
  if (!clean) return "2.25.0";
  // Never remap standard DICOM Transfer Syntax or SOP Class UIDs (1.2.840.10008.*)
  if (clean.startsWith("1.2.840.10008.")) {
    return clean;
  }
  const digest = createHmac("sha256", salt).update(clean).digest("hex");
  const bigVal = BigInt("0x" + digest.slice(0, 30));
  const candidate = `2.25.${bigVal.toString(10)}`;
  return candidate.slice(0, 64);
}

/**
 * Shifts a DICOM DA string (`YYYYMMDD`) by a deterministic day offset so longitudinal
 * inter-study intervals remain accurate while removing exact calendar dates.
 */
export function shiftDicomDate(dicomDate: string, shiftDays: number = -365): string {
  const clean = dicomDate.replace(/[^0-9]/g, "");
  if (clean.length < 8) return "19000101";
  const y = Number.parseInt(clean.slice(0, 4), 10);
  const m = Number.parseInt(clean.slice(4, 6), 10) - 1;
  const d = Number.parseInt(clean.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  if (Number.isNaN(dt.getTime())) return "19000101";
  dt.setUTCDate(dt.getUTCDate() + shiftDays);
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function tagHex(group: number, elem: number): string {
  return `${group.toString(16).padStart(4, "0").toLowerCase()},${elem.toString(16).padStart(4, "0").toLowerCase()}`;
}

function encodeExplicitElement(
  group: number,
  elem: number,
  vr: string,
  payload: Uint8Array,
): Uint8Array {
  const paddedLen = payload.byteLength % 2 === 1 ? payload.byteLength + 1 : payload.byteLength;
  const padByte = vr === "UI" || vr === "OB" || vr === "OW" || vr === "UN" ? 0x00 : 0x20;
  const isLong = LONG_VRS.has(vr);
  const headerLen = isLong ? 12 : 8;
  const out = new Uint8Array(headerLen + paddedLen);
  const view = new DataView(out.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, elem, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  if (isLong) {
    view.setUint16(6, 0, true);
    view.setUint32(8, paddedLen, true);
  } else {
    view.setUint16(6, paddedLen, true);
  }
  out.set(payload, headerLen);
  if (paddedLen > payload.byteLength) {
    out[headerLen + payload.byteLength] = padByte;
  }
  return out;
}

function encodeStringPayload(text: string, vr: string): Uint8Array {
  const bytes = Array.from(new TextEncoder().encode(text));
  if (bytes.length % 2 === 1) {
    bytes.push(vr === "UI" ? 0x00 : 0x20);
  }
  return new Uint8Array(bytes);
}

/**
 * Inspects top and bottom pixel border strips (top 15% and bottom 15% of rows) for
 * high-contrast, sharp-gradient isolated foreground strokes characteristic of burned-in
 * text banners on ultrasound or secondary capture images.
 */
export function detectPixelBorderOverlay(
  pixels: Float32Array | Uint8Array | Uint8ClampedArray,
  rows: number,
  cols: number,
): { suspected: boolean; borderSharpTransitionRatio: number; reason: string | null } {
  if (!pixels || rows < 8 || cols < 8 || pixels.length < rows * cols) {
    return { suspected: false, borderSharpTransitionRatio: 0, reason: null };
  }

  let minVal = Infinity;
  let maxVal = -Infinity;
  const n = rows * cols;
  for (let i = 0; i < n; i++) {
    const v = pixels[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const span = maxVal - minVal;
  if (span <= 1e-5) {
    return { suspected: false, borderSharpTransitionRatio: 0, reason: null };
  }

  const highThresh = minVal + 0.78 * span;
  const gradThresh = 0.45 * span;
  const borderRows = Math.max(2, Math.floor(rows * 0.15));

  let borderSamples = 0;
  let sharpTransitions = 0;
  let brightBorderPixels = 0;

  const checkRowBand = (rStart: number, rEnd: number) => {
    for (let r = rStart; r < rEnd; r++) {
      for (let c = 1; c < cols - 1; c++) {
        borderSamples++;
        const v = pixels[r * cols + c];
        const vPrev = pixels[r * cols + (c - 1)];
        if (v >= highThresh) brightBorderPixels++;
        if (Math.abs(v - vPrev) >= gradThresh) {
          sharpTransitions++;
        }
      }
    }
  };

  checkRowBand(0, borderRows);
  checkRowBand(rows - borderRows, rows);

  const transitionRatio = borderSamples > 0 ? sharpTransitions / borderSamples : 0;
  const brightRatio = borderSamples > 0 ? brightBorderPixels / borderSamples : 0;

  const suspected = transitionRatio >= 0.035 && brightRatio >= 0.008 && brightRatio <= 0.55;
  return {
    suspected,
    borderSharpTransitionRatio: Number(transitionRatio.toFixed(4)),
    reason: suspected
      ? `High-contrast sharp horizontal intensity transitions (${(transitionRatio * 100).toFixed(1)}% of border pixels) detected in top/bottom image border bands, consistent with potential burned-in text overlay.`
      : null,
  };
}

/**
 * Evaluates both DICOM header flags and top/bottom border pixel high-contrast edge density
 * to detect potential burned-in annotations (common on ultrasound captures and secondary
 * captures).
 */
export function detectBurnedInAnnotationRisk(params: {
  burnedInAnnotationTag: string | null;
  recognizableVisualFeaturesTag: string | null;
  modality: string | null;
  sopClassUid: string | null;
  imageType?: string | null;
  rows: number;
  cols: number;
  bitsAllocated: number;
  pixelBytes: Uint8Array | null;
  decodedPixels?: Float32Array | Uint8Array | Uint8ClampedArray | null;
}): BurnedInPixelAnnotationReport {
  const headerBurnedIn = (params.burnedInAnnotationTag ?? "").trim().toUpperCase();
  const headerVisual = (params.recognizableVisualFeaturesTag ?? "").trim().toUpperCase();
  const modality = (params.modality ?? "").trim().toUpperCase();
  const sopClass = (params.sopClassUid ?? "").trim();
  const imageType = (params.imageType ?? "").trim();

  const suspectedRegions: string[] = [];
  let highContrastBorderRatio = 0;
  let borderEdgeDensity = 0;

  if (params.decodedPixels && params.rows >= 8 && params.cols >= 8) {
    const pxOverlay = detectPixelBorderOverlay(params.decodedPixels, params.rows, params.cols);
    borderEdgeDensity = pxOverlay.borderSharpTransitionRatio;
    if (pxOverlay.suspected) {
      suspectedRegions.push("top_or_bottom_border_pixel_banner");
    }
  }

  if (params.pixelBytes && params.rows >= 16 && params.cols >= 16) {
    const bytesPerPixel = Math.max(1, Math.floor((params.bitsAllocated || 8) / 8));
    const framePixels = params.rows * params.cols;
    if (params.pixelBytes.byteLength >= framePixels * bytesPerPixel) {
      const view = new DataView(
        params.pixelBytes.buffer,
        params.pixelBytes.byteOffset,
        params.pixelBytes.byteLength,
      );
      const readPx = (idx: number): number => {
        if (bytesPerPixel >= 2) {
          return view.getUint16(idx * 2, true);
        }
        return params.pixelBytes![idx];
      };

      let maxVal = 0;
      for (let i = 0; i < framePixels; i++) {
        const v = readPx(i);
        if (v > maxVal) maxVal = v;
      }

      if (maxVal > 0) {
        const topRows = Math.max(2, Math.floor(params.rows * 0.15));
        const bottomStart = Math.min(params.rows - 2, Math.floor(params.rows * 0.85));
        const brightThreshold = maxVal * 0.82;
        const stepThreshold = maxVal * 0.45;

        let borderCount = 0;
        let brightCount = 0;
        let edgeCount = 0;
        let topEdges = 0;
        let bottomEdges = 0;

        for (let r = 0; r < params.rows; r++) {
          const inTop = r < topRows;
          const inBottom = r >= bottomStart;
          if (!inTop && !inBottom) continue;
          for (let c = 1; c < params.cols; c++) {
            const v = readPx(r * params.cols + c);
            const prev = readPx(r * params.cols + (c - 1));
            borderCount++;
            if (v >= brightThreshold) brightCount++;
            if (Math.abs(v - prev) >= stepThreshold) {
              edgeCount++;
              if (inTop) topEdges++;
              if (inBottom) bottomEdges++;
            }
          }
        }

        if (borderCount > 0) {
          highContrastBorderRatio = Number((brightCount / borderCount).toFixed(4));
          borderEdgeDensity = Number(
            Math.max(borderEdgeDensity, edgeCount / borderCount).toFixed(4),
          );
          const bandPixels = topRows * Math.max(1, params.cols - 1);
          if (topEdges / bandPixels >= 0.06 && brightCount / borderCount <= 0.5) {
            suspectedRegions.push("top_border_banner (rows 0.." + topRows + ")");
          }
          if (bottomEdges / bandPixels >= 0.06 && brightCount / borderCount <= 0.5) {
            suspectedRegions.push(
              "bottom_border_banner (rows " + bottomStart + ".." + params.rows + ")",
            );
          }
        }
      }
    }
  }

  const isSecondaryCapture =
    sopClass === "1.2.840.10008.5.1.4.1.1.7" || /SECONDARY|SCREEN/i.test(imageType);
  const isUltrasoundModality = ["US", "IVUS", "ES", "SC", "XC", "OT"].includes(modality);
  const explicitHeaderYes = headerBurnedIn === "YES" || headerVisual === "YES";
  const borderGlyphsDetected = suspectedRegions.length > 0;

  const burnedInAnnotationDetected =
    explicitHeaderYes || borderGlyphsDetected || isSecondaryCapture;

  let riskLevel: "low" | "moderate" | "high" = "low";
  if (explicitHeaderYes || borderGlyphsDetected || isSecondaryCapture) {
    riskLevel = "high";
  } else if (isUltrasoundModality || headerBurnedIn === "") {
    riskLevel = "moderate";
  }

  let warning: string | null = null;
  if (burnedInAnnotationDetected) {
    warning =
      "Potential burned-in pixel annotations detected (" +
      [
        explicitHeaderYes ? `BurnedInAnnotation=${headerBurnedIn || headerVisual}` : null,
        isSecondaryCapture ? "Secondary Capture SOP Class / ImageType" : null,
        borderGlyphsDetected ? `high-contrast border glyphs in ${suspectedRegions.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; ") +
      "). Metadata de-identification alone does NOT remove pixel-embedded text; manual pixel review or region masking is required before external sharing.";
  } else if (riskLevel === "moderate") {
    warning =
      "BurnedInAnnotation (0028,0301) is not explicitly 'NO' or modality is Ultrasound/Endoscopy; verify pixel data contains no burned-in text before external distribution.";
  }

  return {
    burnedInAnnotationHeaderFlag: headerBurnedIn || null,
    recognizableVisualFeaturesFlag: headerVisual || null,
    highContrastBorderRatio,
    borderEdgeDensity,
    suspectedBurnedInTextRegions: suspectedRegions,
    burnedInAnnotationDetected,
    riskLevel,
    warning,
    reasons: warning ? [warning] : [],
  };
}

interface ParsedItemContext {
  standardTagsScrubbed: Set<string>;
  privateTagsRemoved: Set<string>;
  nestedSequenceTagsScrubbed: Set<string>;
  datesShifted: Record<string, { originalMask: string; shiftedTo: string }>;
  datesModified: Set<string>;
  uidRemappingTable: Record<string, string>;
  preservedGeometryTags: Record<string, string>;
  uidSalt: string;
  dateShiftDays: number;
  patientIdReplacement: string;
  patientNameReplacement: string;
  imagePositionPatient: number[] | null;
  imageOrientationPatient: number[] | null;
  pixelSpacingMm: [number, number] | null;
  sliceThicknessMm: number | null;
  spacingBetweenSlicesMm: number | null;
  patientPosition: string | null;
  burnedInAnnotationTag: string | null;
  recognizableVisualFeaturesTag: string | null;
  modality: string | null;
  sopClassUid: string | null;
  imageType: string | null;
  rows: number;
  cols: number;
  bitsAllocated: number;
  firstFramePixelBytes: Uint8Array | null;
}

function deidentifyElementStream(
  buf: Uint8Array,
  startOffset: number,
  endOffset: number,
  ctx: ParsedItemContext,
  insideSequence: boolean,
): Uint8Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = startOffset;

  while (offset + 8 <= endOffset) {
    const group = view.getUint16(offset, true);
    const elem = view.getUint16(offset + 2, true);

    // Handle sequence / item delimiter markers (FFFE,E000 / FFFE,E00D / FFFE,E0DD)
    if (group === 0xfffe) {
      const markerLength = view.getUint32(offset + 4, true);
      if (elem === 0xe000 && markerLength > 0 && markerLength !== 0xffffffff) {
        const itemStart = offset + 8;
        const itemEnd = Math.min(endOffset, itemStart + markerLength);
        const deidItemPayload = deidentifyElementStream(
          buf,
          itemStart,
          itemEnd,
          ctx,
          true,
        );
        const itemHeader = new Uint8Array(8);
        const ihView = new DataView(itemHeader.buffer);
        ihView.setUint16(0, 0xfffe, true);
        ihView.setUint16(2, 0xe000, true);
        ihView.setUint32(4, deidItemPayload.byteLength, true);
        chunks.push(itemHeader, deidItemPayload);
        offset = itemEnd;
        continue;
      }
      chunks.push(buf.slice(offset, offset + 8));
      offset += 8;
      continue;
    }

    const vrCandidate = String.fromCharCode(buf[offset + 4], buf[offset + 5]);
    const isExplicit = /^[A-Z]{2}$/.test(vrCandidate);
    let vr = isExplicit ? vrCandidate : "UN";
    let length = 0;
    let valueOffset = 0;

    if (isExplicit && LONG_VRS.has(vr)) {
      if (offset + 12 > endOffset) break;
      length = view.getUint32(offset + 8, true);
      valueOffset = offset + 12;
    } else if (isExplicit) {
      length = view.getUint16(offset + 6, true);
      valueOffset = offset + 8;
    } else {
      length = view.getUint32(offset + 4, true);
      valueOffset = offset + 8;
    }

    // Undefined length PixelData or Sequence until endOffset
    if (length === 0xffffffff) {
      chunks.push(buf.slice(offset, endOffset));
      break;
    }

    if (valueOffset + length > endOffset) {
      break;
    }

    const key = tagHex(group, elem);
    const valSlice = buf.subarray(valueOffset, valueOffset + length);

    // 1. Remove ALL odd-group private tags (e.g., 0009,xxxx, 0019,xxxx, 0029,xxxx)
    if (group % 2 === 1 && group > 0x0007 && group !== 0x7fe0) {
      ctx.privateTagsRemoved.add(key);
      if (insideSequence) {
        ctx.nestedSequenceTagsScrubbed.add(key);
      }
      offset = valueOffset + length;
      continue;
    }

    // 2. Recursively process nested sequences (VR === "SQ")
    if (vr === "SQ") {
      if (key === "0008,0082") {
        // InstitutionCodeSequence: scrub completely
        ctx.standardTagsScrubbed.add(key);
        chunks.push(encodeExplicitElement(group, elem, "SQ", new Uint8Array(0)));
        offset = valueOffset + length;
        continue;
      }
      const deidSeqPayload = deidentifyElementStream(
        buf,
        valueOffset,
        valueOffset + length,
        ctx,
        true,
      );
      chunks.push(encodeExplicitElement(group, elem, "SQ", deidSeqPayload));
      offset = valueOffset + length;
      continue;
    }

    // 3. Record preserved geometry & pixel metadata for audit verification
    const readAscii = () =>
      new TextDecoder()
        .decode(valSlice)
        .replace(/\0/g, "")
        .trim();

    if (GEOMETRY_TAGS_TO_PRESERVE.has(key)) {
      ctx.preservedGeometryTags[key] = readAscii();
    }

    if (key === "0020,0032") {
      const nums = readAscii().split("\\").map(Number);
      if (nums.length >= 3 && nums.every(Number.isFinite)) ctx.imagePositionPatient = nums.slice(0, 3);
    } else if (key === "0020,0037") {
      const nums = readAscii().split("\\").map(Number);
      if (nums.length >= 6 && nums.every(Number.isFinite)) ctx.imageOrientationPatient = nums.slice(0, 6);
    } else if (key === "0028,0030") {
      const nums = readAscii().split("\\").map(Number);
      if (nums.length >= 2 && nums.every(Number.isFinite)) ctx.pixelSpacingMm = [nums[0], nums[1]];
    } else if (key === "0018,0050") {
      const v = Number(readAscii());
      if (Number.isFinite(v)) ctx.sliceThicknessMm = v;
    } else if (key === "0018,0088") {
      const v = Number(readAscii());
      if (Number.isFinite(v)) ctx.spacingBetweenSlicesMm = v;
    } else if (key === "0018,5100") {
      ctx.patientPosition = readAscii();
    } else if (key === "0028,0301") {
      ctx.burnedInAnnotationTag = readAscii();
    } else if (key === "0028,0302") {
      ctx.recognizableVisualFeaturesTag = readAscii();
    } else if (key === "0008,0060") {
      ctx.modality = readAscii();
    } else if (key === "0008,0016") {
      ctx.sopClassUid = readAscii();
    } else if (key === "0008,0008") {
      ctx.imageType = readAscii();
    } else if (key === "0028,0010" && length >= 2) {
      ctx.rows = view.getUint16(valueOffset, true);
    } else if (key === "0028,0011" && length >= 2) {
      ctx.cols = view.getUint16(valueOffset, true);
    } else if (key === "0028,0100" && length >= 2) {
      ctx.bitsAllocated = view.getUint16(valueOffset, true);
    } else if (key === "7fe0,0010" && length > 0 && !ctx.firstFramePixelBytes) {
      ctx.firstFramePixelBytes = buf.slice(valueOffset, valueOffset + length);
    }

    // 4. Deterministic UID remapping (Study/Series/SOP/FrameOfReference/ReferencedSOP)
    if (REMAP_UID_TAGS.has(key)) {
      const origUid = readAscii();
      const remappedUid = remapDicomUid(origUid, ctx.uidSalt);
      if (origUid) {
        ctx.uidRemappingTable[origUid] = remappedUid;
      }
      ctx.standardTagsScrubbed.add(key);
      if (insideSequence) {
        ctx.nestedSequenceTagsScrubbed.add(key);
      }
      chunks.push(
        encodeExplicitElement(
          group,
          elem,
          isExplicit ? vr : "UI",
          encodeStringPayload(remappedUid, "UI"),
        ),
      );
      offset = valueOffset + length;
      continue;
    }

    // 5. Standard PS3.15 identifying tags
    const action = IDENTIFYING_TAGS_ACTION[key];
    if (action) {
      ctx.standardTagsScrubbed.add(key);
      if (insideSequence) {
        ctx.nestedSequenceTagsScrubbed.add(key);
      }
      const targetVr = isExplicit ? vr : "LO";
      if (action === "empty") {
        chunks.push(encodeExplicitElement(group, elem, targetVr, new Uint8Array(0)));
      } else if (action === "replace_anon") {
        let replacement = "ANONYMIZED";
        if (key === "0010,0020") replacement = ctx.patientIdReplacement;
        else if (key === "0010,0010") replacement = ctx.patientNameReplacement;
        chunks.push(
          encodeExplicitElement(
            group,
            elem,
            targetVr,
            encodeStringPayload(replacement, targetVr),
          ),
        );
      } else if (action === "shift_date") {
        const origDate = readAscii();
        const shifted = shiftDicomDate(origDate, ctx.dateShiftDays);
        ctx.datesShifted[key] = {
          originalMask: origDate ? `${origDate.slice(0, 4)}****` : "empty",
          shiftedTo: shifted,
        };
        ctx.datesModified.add(key);
        chunks.push(
          encodeExplicitElement(group, elem, "DA", encodeStringPayload(shifted, "DA")),
        );
      } else if (action === "scrub_time") {
        ctx.datesModified.add(key);
        chunks.push(
          encodeExplicitElement(group, elem, "TM", encodeStringPayload("000000.000000", "TM")),
        );
      }
      offset = valueOffset + length;
      continue;
    }

    // 6. Keep non-identifying element untouched (including all geometry, functional groups, pixel data)
    chunks.push(buf.slice(offset, valueOffset + length));
    offset = valueOffset + length;
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/**
 * De-identifies a DICOM Part-10 byte buffer into a new derived DICOM Part-10 buffer
 * without mutating the input `raw` buffer.
 */
export function deidentifyDicomBytes(
  raw: Uint8Array,
  options: DicomDeidentifyOptions = {},
): DicomDeidentificationResult {
  if (!raw || raw.byteLength < 140) {
    throw new Error("Cannot de-identify DICOM: buffer is smaller than the 132-byte Part-10 header.");
  }
  const magic = String.fromCharCode(raw[128], raw[129], raw[130], raw[131]);
  if (magic !== "DICM") {
    throw new Error("Cannot de-identify DICOM: missing Part-10 'DICM' magic at offset 128.");
  }

  const originalSha256 = createHash("sha256").update(raw).digest("hex");
  const pseudoDefault = options.pseudonymId ?? "ANON-PATIENT";

  const ctx: ParsedItemContext = {
    standardTagsScrubbed: new Set<string>(),
    privateTagsRemoved: new Set<string>(),
    nestedSequenceTagsScrubbed: new Set<string>(),
    datesShifted: {},
    datesModified: new Set<string>(),
    uidRemappingTable: {},
    preservedGeometryTags: {},
    uidSalt: options.uidSalt ?? "reprocare-ps315-default-salt",
    dateShiftDays: options.dateShiftDays ?? -365,
    patientIdReplacement: options.patientIdReplacement ?? pseudoDefault,
    patientNameReplacement: options.patientNameReplacement ?? (options.pseudonymId ?? "ANONYMIZED^PATIENT"),
    imagePositionPatient: null,
    imageOrientationPatient: null,
    pixelSpacingMm: null,
    sliceThicknessMm: null,
    spacingBetweenSlicesMm: null,
    patientPosition: null,
    burnedInAnnotationTag: null,
    recognizableVisualFeaturesTag: null,
    modality: null,
    sopClassUid: null,
    imageType: null,
    rows: options.rows ?? 0,
    cols: options.cols ?? 0,
    bitsAllocated: 8,
    firstFramePixelBytes: null,
  };

  // Zero out the 128-byte preamble so no vendor/workstation strings leak in the preamble
  const preambleAndMagic = new Uint8Array(132);
  preambleAndMagic[128] = 0x44; // 'D'
  preambleAndMagic[129] = 0x49; // 'I'
  preambleAndMagic[130] = 0x43; // 'C'
  preambleAndMagic[131] = 0x4d; // 'M'

  const deidBody = deidentifyElementStream(raw, 132, raw.byteLength, ctx, false);
  const derivedBytes = Buffer.alloc(132 + deidBody.byteLength);
  derivedBytes.set(preambleAndMagic, 0);
  derivedBytes.set(deidBody, 132);

  const postOriginalSha256 = createHash("sha256").update(raw).digest("hex");
  const derivedSha256 = createHash("sha256").update(derivedBytes).digest("hex");

  const burnedInReport = detectBurnedInAnnotationRisk({
    burnedInAnnotationTag: ctx.burnedInAnnotationTag,
    recognizableVisualFeaturesTag: ctx.recognizableVisualFeaturesTag,
    modality: ctx.modality,
    sopClassUid: ctx.sopClassUid,
    imageType: ctx.imageType,
    rows: ctx.rows,
    cols: ctx.cols,
    bitsAllocated: ctx.bitsAllocated,
    pixelBytes: ctx.firstFramePixelBytes,
    decodedPixels: options.decodedPixels,
  });

  const manualReviewRequired =
    burnedInReport.burnedInAnnotationDetected || burnedInReport.riskLevel !== "low";

  const burnedInAnnotationRisk: "none" | "moderate" | "high" =
    burnedInReport.riskLevel === "low" ? "none" : burnedInReport.riskLevel;
  const burnedInReasons: string[] = burnedInReport.warning ? [burnedInReport.warning] : [];

  return {
    derivedBytes,
    originalSha256,
    derivedSha256,
    originalPreserved: originalSha256 === postOriginalSha256,
    originalByteLength: raw.byteLength,
    derivedByteLength: derivedBytes.byteLength,
    originalBufferUnchanged: originalSha256 === postOriginalSha256,
    standardTagsScrubbed: Array.from(ctx.standardTagsScrubbed).sort(),
    privateTagsRemoved: Array.from(ctx.privateTagsRemoved).sort(),
    nestedSequenceTagsScrubbed: Array.from(ctx.nestedSequenceTagsScrubbed).sort(),
    datesShifted: ctx.datesShifted,
    datesModified: Array.from(ctx.datesModified).sort(),
    uidRemappingTable: ctx.uidRemappingTable,
    uidRemappings: ctx.uidRemappingTable,
    geometryPreserved: {
      imagePositionPatient: ctx.imagePositionPatient,
      imageOrientationPatient: ctx.imageOrientationPatient,
      pixelSpacingMm: ctx.pixelSpacingMm,
      sliceThicknessMm: ctx.sliceThicknessMm,
      spacingBetweenSlicesMm: ctx.spacingBetweenSlicesMm,
      patientPosition: ctx.patientPosition,
    },
    preservedGeometryTags: ctx.preservedGeometryTags,
    burnedInReport,
    burnedInAnnotationRisk,
    burnedInReasons,
    pixelBorderTextSuspected: burnedInReport.suspectedBurnedInTextRegions.length > 0,
    manualReviewRequired,
    claimCompleteAnonymisation: false,
    profileApplied: "DICOM_PS3.15_Basic_Application_Level_Confidentiality_Profile",
    anonymisationStatus: manualReviewRequired
      ? "metadata_deidentified_manual_pixel_review_required"
      : "metadata_deidentified_pixel_clean",
    auditNotice:
      "DICOM PS3.15 Basic Application Level Confidentiality Profile applied to metadata, private tags, and nested sequences. Complete anonymisation is NEVER guaranteed by metadata removal alone; verify pixel data before external clinical or research release.",
  };
}

export const deidentifyDicomPart10 = deidentifyDicomBytes;

import { gunzipSync, gzipSync } from "node:zlib";

export interface NiftiDeidentificationResult {
  derivedBytes: Uint8Array;
  wasGzipped: boolean;
  originalSha256: string;
  derivedSha256: string;
  originalPreserved: boolean;
  fieldsScrubbed: string[];
  extensionBytesRemoved: number;
  geometryPreserved: {
    dims: number[];
    pixdimMm: [number, number, number];
    qformCode: number;
    sformCode: number;
    qoffsetMm: [number, number, number];
    srowX: [number, number, number, number];
    srowY: [number, number, number, number];
    srowZ: [number, number, number, number];
  };
  claimCompleteAnonymisation: false;
  manualReviewRequired: boolean;
  auditNotice: string;
}

/**
 * Scrubs identifying metadata (`descrip`, `aux_file`, `intent_name`) and removes embedded
 * NIfTI-1 header extension blocks (`extension[0] != 0`) from `.nii` and `.nii.gz` buffers
 * while preserving 3D/4D voxel data and `qform`/`sform` patient-space affine geometry.
 */
export function deidentifyNiftiBytes(
  originalInput: Uint8Array | Buffer,
  options?: { replacementDescrip?: string },
): NiftiDeidentificationResult {
  if (!originalInput || originalInput.byteLength < 18) {
    throw new Error("Invalid NIfTI input: buffer is smaller than 348-byte NIfTI-1 header.");
  }

  const originalCopy = new Uint8Array(originalInput.byteLength);
  originalCopy.set(originalInput);
  const originalSha256 = createHash("sha256").update(originalCopy).digest("hex");

  const isGzip = originalInput[0] === 0x1f && originalInput[1] === 0x8b;
  const rawNii = isGzip ? new Uint8Array(gunzipSync(originalCopy)) : new Uint8Array(originalCopy);

  if (rawNii.byteLength < 352) {
    throw new Error("Invalid NIfTI-1 stream: decompressed buffer is smaller than 352 bytes.");
  }

  const dv = new DataView(rawNii.buffer, rawNii.byteOffset, rawNii.byteLength);
  const sizeofHdrLE = dv.getInt32(0, true);
  const littleEndian = sizeofHdrLE === 348;
  const sizeofHdr = littleEndian ? sizeofHdrLE : dv.getInt32(0, false);
  if (sizeofHdr !== 348) {
    throw new Error(`Invalid NIfTI-1 header: expected sizeof_hdr=348, got ${sizeofHdr}.`);
  }

  const magic = new TextDecoder("ascii").decode(rawNii.subarray(344, 348));
  if (magic !== "n+1\0" && magic !== "ni1\0") {
    throw new Error(`Invalid NIfTI-1 magic '${magic.replace(/\0/g, "")}'.`);
  }

  const readText = (start: number, len: number) =>
    new TextDecoder("utf8")
      .decode(rawNii.subarray(start, start + len))
      .replace(/\0/g, "")
      .trim();

  const fieldsScrubbed: string[] = [];
  if (readText(148, 80).length > 0) fieldsScrubbed.push("descrip");
  if (readText(228, 24).length > 0) fieldsScrubbed.push("aux_file");
  if (readText(328, 16).length > 0) fieldsScrubbed.push("intent_name");

  // Zero out descrip (148..228), aux_file (228..252), intent_name (328..344), db_name (14..32)
  if (readText(14, 18).length > 0) fieldsScrubbed.push("db_name");
  rawNii.fill(0, 14, 32);
  rawNii.fill(0, 148, 252);
  rawNii.fill(0, 328, 344);

  const repDesc = (options?.replacementDescrip ?? "ANON_NIFTI").slice(0, 79);
  const repBytes = new TextEncoder().encode(repDesc);
  rawNii.set(repBytes, 148);

  const origVoxOffset = Math.max(352, Math.round(dv.getFloat32(108, littleEndian)));
  const hasExtension = rawNii[348] !== 0 || origVoxOffset > 352;
  const extensionBytesRemoved = Math.max(0, origVoxOffset - 352);
  if (hasExtension) {
    fieldsScrubbed.push("nifti_extensions");
  }

  // Clear extension[0..3] bytes at 348..352 and set vox_offset = 352.0
  rawNii[348] = 0;
  rawNii[349] = 0;
  rawNii[350] = 0;
  rawNii[351] = 0;
  dv.setFloat32(108, 352.0, littleEndian);

  const voxelPayload = rawNii.subarray(Math.min(origVoxOffset, rawNii.byteLength));
  const cleanNii = new Uint8Array(352 + voxelPayload.byteLength);
  cleanNii.set(rawNii.subarray(0, 352), 0);
  cleanNii.set(voxelPayload, 352);

  // Extract preserved geometry
  const cleanDv = new DataView(cleanNii.buffer, cleanNii.byteOffset, cleanNii.byteLength);
  const ndim = cleanDv.getInt16(40, littleEndian);
  const dims: number[] = [];
  for (let i = 1; i <= Math.min(7, Math.max(3, ndim)); i++) {
    dims.push(cleanDv.getInt16(40 + i * 2, littleEndian));
  }
  const pixdimMm: [number, number, number] = [
    Number(cleanDv.getFloat32(76 + 4, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(76 + 8, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(76 + 12, littleEndian).toFixed(6)),
  ];
  const qformCode = cleanDv.getInt16(252, littleEndian);
  const sformCode = cleanDv.getInt16(254, littleEndian);
  const qoffsetMm: [number, number, number] = [
    Number(cleanDv.getFloat32(268, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(272, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(276, littleEndian).toFixed(6)),
  ];
  const readRow4 = (off: number): [number, number, number, number] => [
    Number(cleanDv.getFloat32(off, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(off + 4, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(off + 8, littleEndian).toFixed(6)),
    Number(cleanDv.getFloat32(off + 12, littleEndian).toFixed(6)),
  ];

  const derivedBytes = isGzip ? new Uint8Array(gzipSync(cleanNii)) : cleanNii;
  const derivedSha256 = createHash("sha256").update(derivedBytes).digest("hex");
  const currentOriginalSha = createHash("sha256").update(originalInput).digest("hex");

  return {
    derivedBytes,
    wasGzipped: isGzip,
    originalSha256,
    derivedSha256,
    originalPreserved: currentOriginalSha === originalSha256,
    fieldsScrubbed,
    extensionBytesRemoved,
    geometryPreserved: {
      dims,
      pixdimMm,
      qformCode,
      sformCode,
      qoffsetMm,
      srowX: readRow4(280),
      srowY: readRow4(296),
      srowZ: readRow4(312),
    },
    claimCompleteAnonymisation: false,
    manualReviewRequired: false,
    auditNotice:
      "NIfTI-1 header metadata (db_name, descrip, aux_file, intent_name) and header extension blocks were removed while preserving 3D voxel intensities and qform/sform affine geometry. Header scrubbing alone does not guarantee complete anonymisation if defacing/pixel review is required.",
  };
}
