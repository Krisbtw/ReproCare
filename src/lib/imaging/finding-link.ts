/**
 * Turns a Volume lab result into the fields of a new, append-only finding version.
 * Pure: no database, no DOM. The server function does the insert.
 *
 * Honesty rules baked in:
 * - Coordinates here are image-index millimetres of a locally loaded series, not a patient frame and not
 *   registered to any stored study. So the centroid is NOT stored unless a valid patient coordinate frame is given.
 * - Learned models require explicit clinician confirmation before they can be recorded.
 * - The source model and run ID are recorded for full audit provenance.
 */
import type { MaskMeasurement } from "./metrics.ts";

export const LAB_SEGMENTATION_SOURCE = "classical_region_growing";

export type LabLinkInput = {
  accepted: boolean;
  isLearnedModel: boolean;
  clinicianConfirmed?: boolean;
  modelId?: string | null;
  segmentationRunId?: string | null;
  measurement: MaskMeasurement;
  seed: [number, number, number];
  /** FNV-1a hash of the processing record JSON, so the version can be matched to an exported record. */
  recordHash: string;
  seriesDescription: string | null;
  source: "sample" | "upload";
  reason: string;
  studyId?: string | null;
  seriesId?: string | null;
  seriesUid?: string | null;
  patientCentroidMm?: [number, number, number] | null;
  frame?: "dicom_lps" | "image_registered" | "schematic" | "unavailable";
};

export type LabLinkFields = {
  axes: [number, number, number];
  longest: number;
  volumeMl: number;
  segmentationSource: string;
  frame: "dicom_lps" | "image_registered" | "schematic" | "unavailable";
  centroidMm: [number, number, number] | null;
  modelId: string | null;
  segmentationRunId?: string | null;
  sliceIndex: number;
  changeReason: string;
  evidenceNote: string;
  studyId?: string | null;
  seriesId?: string | null;
};

export type LabLinkResult = { ok: true; fields: LabLinkFields } | { ok: false; problem: string };

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function versionFromLab(input: LabLinkInput): LabLinkResult {
  const reason = input.reason.trim();
  if (reason.length < 8) return { ok: false, problem: "Say why this measurement is being recorded (at least 8 characters)." };
  if (!input.accepted) return { ok: false, problem: "The segmentation was not accepted, so it cannot become a finding version." };
  
  // Learned model results require explicit clinician confirmation
  if (input.isLearnedModel && !input.clinicianConfirmed) {
    return {
      ok: false,
      problem: "Learned-model segmentations require explicit clinician review and confirmation before recording as a finding version.",
    };
  }

  const m = input.measurement;
  if (m.voxelCount === 0 || !m.axesMm || m.longestMm == null) return { ok: false, problem: "The mask has no measurable extent." };
  if (m.componentCount > 1 && m.largestComponentFraction < 0.95) {
    return { ok: false, problem: "The mask has several separate pieces. Refine the seed or window until it is one object." };
  }
  const axes: [number, number, number] = [m.axesMm[0], m.axesMm[1], m.axesMm[2]];
  if (axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) return { ok: false, problem: "Measured extents are outside 0 to 300 mm." };
  const where = input.source === "sample" ? "the synthetic sample" : "a locally loaded series";
  const centroid = input.patientCentroidMm ?? null;
  const frame = input.frame ?? (centroid ? "dicom_lps" : "unavailable");

  const modelSource = input.isLearnedModel
    ? (input.modelId ?? "learned_segmentation_model")
    : LAB_SEGMENTATION_SOURCE;

  return {
    ok: true,
    fields: {
      axes,
      longest: m.longestMm,
      volumeMl: m.volumeMl,
      segmentationSource: modelSource,
      frame,
      centroidMm: centroid,
      modelId: input.isLearnedModel ? (input.modelId ?? "umd_monai_fibroid") : null,
      segmentationRunId: input.segmentationRunId ?? null,
      sliceIndex: input.seed[2],
      changeReason: `Volume lab: ${reason}`,
      evidenceNote:
        input.isLearnedModel
          ? `Measured in ${where}${input.seriesDescription ? ` (${input.seriesDescription})` : ""} using AI model ${input.modelId ?? "UMD U-Net"}. ` +
            `Clinician reviewed and confirmed. Not independently diagnostic. ` +
            `Processing record hash ${input.recordHash}. ` +
            (input.studyId ? `Linked to study ${input.studyId}. ` : `The series is not stored here. `) +
            (centroid ? `Centroid recorded in DICOM LPS coordinates [${centroid.map((v) => v.toFixed(1)).join(", ")}] mm. ` : `Centroid withheld: image-index coordinates are not registered to the stored frame. `) +
            `Principal-axis extents, not a caliper plane.`
          : `Measured in ${where}${input.seriesDescription ? ` (${input.seriesDescription})` : ""} by classical seeded region growing, not a trained model. ` +
            `Seed slice index ${input.seed[2]} in that series' own stack. Processing record hash ${input.recordHash}. ` +
            (input.studyId ? `Linked to study ${input.studyId}. ` : `The series is not stored here and has not been shown to be the study this finding cites. `) +
            (centroid ? `Centroid recorded in DICOM LPS coordinates [${centroid.map((v) => v.toFixed(1)).join(", ")}] mm. ` : `Centroid withheld: image-index coordinates are not registered to the stored frame. `) +
            `Principal-axis extents, not a caliper plane.`,
      studyId: input.studyId ?? null,
      seriesId: input.seriesId ?? null,
    },
  };
}
