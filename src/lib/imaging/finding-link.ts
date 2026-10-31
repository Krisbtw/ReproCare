/**
 * Turns a Volume lab result into the fields of a new, append-only finding version.
 * Pure: no database, no DOM. The server function does the insert.
 *
 * Honesty rules baked in:
 * - Coordinates here are image-index millimetres of a locally loaded series, not a patient frame and not
 *   registered to any stored study. So the centroid is NOT stored and the frame is "unavailable"; ReproTrace
 *   then cannot pair it with an earlier finding and leaves both unpaired and provisional for clinician review.
 * - The source is a classical region-growing run, never a trained model (model id stays null).
 * - The loaded series is not stored and is not proven to be the study the finding already points at.
 */
import type { MaskMeasurement } from "./metrics.ts";

export const LAB_SEGMENTATION_SOURCE = "classical_region_growing";

export type LabLinkInput = {
  accepted: boolean;
  isLearnedModel: boolean;
  measurement: MaskMeasurement;
  seed: [number, number, number];
  /** FNV-1a hash of the processing record JSON, so the version can be matched to an exported record. */
  recordHash: string;
  seriesDescription: string | null;
  source: "sample" | "upload";
  reason: string;
};

export type LabLinkFields = {
  axes: [number, number, number];
  longest: number;
  volumeMl: number;
  segmentationSource: string;
  frame: "unavailable";
  centroidMm: null;
  modelId: null;
  sliceIndex: number;
  changeReason: string;
  evidenceNote: string;
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
  if (input.isLearnedModel) return { ok: false, problem: "Learned-model results are not wired to finding versions yet." };
  const m = input.measurement;
  if (m.voxelCount === 0 || !m.axesMm || m.longestMm == null) return { ok: false, problem: "The mask has no measurable extent." };
  if (m.componentCount > 1 && m.largestComponentFraction < 0.95) {
    return { ok: false, problem: "The mask has several separate pieces. Refine the seed or window until it is one object." };
  }
  const axes: [number, number, number] = [m.axesMm[0], m.axesMm[1], m.axesMm[2]];
  if (axes.some((n) => !Number.isFinite(n) || n <= 0 || n > 300)) return { ok: false, problem: "Measured extents are outside 0 to 300 mm." };
  const where = input.source === "sample" ? "the synthetic sample" : "a locally loaded series";
  return {
    ok: true,
    fields: {
      axes,
      longest: m.longestMm,
      volumeMl: m.volumeMl,
      segmentationSource: LAB_SEGMENTATION_SOURCE,
      frame: "unavailable",
      centroidMm: null,
      modelId: null,
      sliceIndex: input.seed[2],
      changeReason: `Volume lab: ${reason}`,
      evidenceNote:
        `Measured in ${where}${input.seriesDescription ? ` (${input.seriesDescription})` : ""} by classical seeded region growing, not a trained model. ` +
        `Seed slice index ${input.seed[2]} in that series' own stack. Processing record hash ${input.recordHash}. ` +
        `The series is not stored here and has not been shown to be the study this finding cites. Centroid withheld: image-index coordinates are not registered to the stored frame. ` +
        `Principal-axis extents, not a caliper plane.`,
    },
  };
}
