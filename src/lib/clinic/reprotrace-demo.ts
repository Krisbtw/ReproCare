/**
 * SYNTHETIC ReproTrace demonstration (Requirements 1 and 2). Every value here is fabricated for a repeatable
 * prototype demo. Nothing is a real patient, scan, report or clinical result.
 *
 * Two synthetic MR examinations are described by generator specs. The same spec produces:
 *  - real DICOM bytes (series-writer) that Volume Lab can open, and
 *  - an in-memory volume for the existing moment-based rigid registration.
 * Finding centroids are derived from the generator's known lesion geometry through the series' own
 * DICOM geometry (ImagePositionPatient + orientation + spacing), so they are genuine DICOM LPS positions
 * of the synthetic images, not schematic placements.
 */
import { buildSyntheticSeries, syntheticIntensity, type SyntheticSeriesSpec } from "../dicom/series-writer.ts";
import type { Volume, Vec3 } from "../imaging/volume.ts";

export const DEMO_PATIENT_KEY = "rtdemo";
export const DEMO_ROOT = "1.2.826.0.1.3680043.10.543.77";

export type DemoExam = {
  key: "rtdemo-ex1" | "rtdemo-ex2";
  seriesKey: string;
  findingKey: string;
  versionKey: string;
  code: string;
  date: string;
  accession: string;
  description: string;
  frameOfReferenceUid: string;
  spec: SyntheticSeriesSpec & { originMm: [number, number, number]; lesionCenterMm: [number, number, number] };
};

const BASE = { cols: 48, rows: 48, pixelSpacingMm: [1.25, 1.25] as [number, number], noise: 0 };

export const DEMO_EXAMS: DemoExam[] = [
  {
    key: "rtdemo-ex1",
    seriesKey: "rtdemo-ex1-s",
    findingKey: "rtdemo-f1",
    versionKey: "rtdemo-f1-v1",
    code: "RT-01",
    date: "2025-03-10",
    accession: "SYN-RT-EX1",
    description: "SYNTHETIC pelvic MRI, examination 1",
    frameOfReferenceUid: `${DEMO_ROOT}.1.9`,
    spec: {
      ...BASE,
      slices: 20,
      sliceStepMm: 3,
      lesionRadiiMm: [8, 7, 6],
      lesionCenterMm: [36, 26, 30],
      organ: { centerMm: [30, 30, 28.5], radiiMm: [22, 16, 18], intensity: 250 },
      originMm: [-30, -30, -30],
      seriesUid: `${DEMO_ROOT}.1.2`,
      studyUid: `${DEMO_ROOT}.1.1`,
      sopRoot: `${DEMO_ROOT}.1.3`,
      studyDate: "20250310",
      description: "SYNTHETIC sagittal T2, examination 1",
    },
  },
  {
    key: "rtdemo-ex2",
    seriesKey: "rtdemo-ex2-s",
    findingKey: "rtdemo-f2",
    versionKey: "rtdemo-f2-v1",
    code: "RT-11",
    date: "2025-09-12",
    accession: "SYN-RT-EX2",
    description: "SYNTHETIC pelvic MRI, examination 2 (patient repositioned, thinner slices)",
    frameOfReferenceUid: `${DEMO_ROOT}.2.9`,
    spec: {
      ...BASE,
      slices: 26,
      sliceStepMm: 2.5,
      // Same anatomy, shifted in scanner space by (+8, -5, +6) mm; lesion has grown.
      lesionRadiiMm: [9.5, 8, 7],
      lesionCenterMm: [44, 21, 36],
      organ: { centerMm: [38, 25, 34.5], radiiMm: [22, 16, 18], intensity: 250 },
      originMm: [-30, -30, -30],
      seriesUid: `${DEMO_ROOT}.2.2`,
      studyUid: `${DEMO_ROOT}.2.1`,
      sopRoot: `${DEMO_ROOT}.2.3`,
      studyDate: "20250912",
      description: "SYNTHETIC sagittal T2, examination 2",
    },
  },
];

/** Identity orientation in the demo, so LPS = origin + image millimetres. */
export function lesionCentroidLps(exam: DemoExam): [number, number, number] {
  const o = exam.spec.originMm;
  const c = exam.spec.lesionCenterMm;
  return [o[0] + c[0], o[1] + c[1], o[2] + c[2]];
}

export function lesionSliceIndex(exam: DemoExam): number {
  return Math.round(exam.spec.lesionCenterMm[2] / exam.spec.sliceStepMm);
}

export function lesionSopInstanceUid(exam: DemoExam): string {
  return `${exam.spec.sopRoot}.${1000 + lesionSliceIndex(exam)}`;
}

export function demoGeometryJson(exam: DemoExam): string {
  return JSON.stringify({
    synthetic: true,
    originLpsMm: exam.spec.originMm,
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    pixelSpacingMm: exam.spec.pixelSpacingMm,
    sliceStepMm: exam.spec.sliceStepMm,
    dims: [exam.spec.cols, exam.spec.rows, exam.spec.slices],
  });
}

export function buildDemoSeriesFiles(exam: DemoExam): { name: string; bytes: Uint8Array }[] {
  return buildSyntheticSeries(exam.spec);
}

/** In-memory volume from the same generator (no DICOM round trip). */
export function buildDemoVolume(exam: DemoExam): Volume {
  const { cols, rows, slices } = exam.spec;
  const data = new Float32Array(cols * rows * slices);
  for (let k = 0; k < slices; k += 1)
    for (let y = 0; y < rows; y += 1)
      for (let x = 0; x < cols; x += 1) data[x + cols * (y + rows * k)] = syntheticIntensity(exam.spec, x, y, k);
  return {
    dims: [cols, rows, slices],
    spacingMm: [exam.spec.pixelSpacingMm[1], exam.spec.pixelSpacingMm[0], exam.spec.sliceStepMm] as Vec3,
    data,
  };
}

/** Synthetic report text for each examination. Page markers let the extractor record page numbers. */
export const DEMO_REPORTS: Record<DemoExam["key"], string[]> = {
  "rtdemo-ex1": [
    "[Page 1]",
    "SYNTHETIC DEMONSTRATION REPORT - not a real patient.",
    "Pelvic MRI. Study date: 2025-03-10.",
    "Technique: sagittal T2 weighted imaging.",
    "[Page 2]",
    "Findings: Anterior intramural fibroid (FIGO 4) measuring 1.6 x 1.4 x 1.2 cm.",
    "Both ovaries are normal in appearance.",
    "Impression: Single anterior intramural fibroid.",
  ],
  "rtdemo-ex2": [
    "[Page 1]",
    "SYNTHETIC DEMONSTRATION REPORT - not a real patient.",
    "Pelvic MRI follow-up. Study date: 2025-09-12.",
    "[Page 2]",
    "Findings: Anterior intramural fibroid (FIGO 4) now measuring 1.9 x 1.6 x 1.4 cm.",
    "No new adnexal lesion.",
    "Impression: Known anterior intramural fibroid, slightly larger.",
  ],
};
