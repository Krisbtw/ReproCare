import {
  matchChronology,
  methodGap,
  reportGap,
  sameMethodChange,
  segmentationGap,
  type Discrepancy,
  type Measure,
  type Proposal,
  type Snap,
} from "../reprotrace/engine.ts";

export type VersionSeed = {
  key: string;
  source: string;
  modelId: string | null;
  axes: [number, number, number] | null;
  longest: number | null;
  reportLongest: number | null;
  reason: string;
  quote: string | null;
  slice: number | null;
};

export type FindingSeed = {
  key: string;
  code: string;
  patient: "meera" | "aisha" | "kavya" | "divya";
  study: string;
  structure: string;
  organ: string;
  pathway: string;
  location: string;
  figo: string | null;
  centroid: [number, number, number] | null;
  frame: "schematic" | "unavailable" | "image_registered";
  quality: "adequate" | "limited" | "unknown";
  modality: string;
  basis: string;
  versions: VersionSeed[];
};

export const PATIENTS = [
  {
    key: "meera",
    code: "SYN-F01",
    name: "Meera Iyer",
    yob: 1986,
    pathway: "fibroids",
    self: false,
    synopsis:
      "Synthetic fibroid pathway with two schematic MRI timepoints and one ultrasound. Built to show evidence linking, versioning, and follow-up rules. Not a real person and not a real scan.",
  },
  {
    key: "aisha",
    code: "SYN-E02",
    name: "Aisha Qureshi",
    yob: 1992,
    pathway: "endometriosis",
    self: false,
    synopsis:
      "Synthetic endometriosis pathway. A visible lesion is not a diagnosis, and the absence of a visible lesion would not exclude endometriosis.",
  },
  {
    key: "kavya",
    code: "SYN-P03",
    name: "Kavya Menon",
    yob: 1997,
    pathway: "pcos",
    self: true,
    synopsis:
      "Synthetic PCOS pathway focused on cycles, symptoms, and labs. Ovarian appearance is recorded as a finding someone entered. It is not used here to diagnose PCOS.",
  },
  {
    key: "divya",
    code: "SYN-C04",
    name: "Divya Shah",
    yob: 1989,
    pathway: "cyst",
    self: false,
    synopsis:
      "Synthetic ovarian cyst follow-up. No malignancy score is generated. Characterization stays with the clinician note.",
  },
] as const;

export const STUDIES = [
  { key: "meera-mr1", patient: "meera", modality: "MR", date: "2024-11-12", description: "Pelvic MRI, schematic T2", accession: "SYN-MR-2411", note: "Synthetic study. Coordinate frame is a teaching schematic, not a registered acquisition." },
  { key: "meera-us", patient: "meera", modality: "US", date: "2025-02-14", description: "Pelvic ultrasound", accession: "SYN-US-2502", note: "Synthetic ultrasound. No shared 3D coordinate frame with the MRI studies." },
  { key: "meera-mr2", patient: "meera", modality: "MR", date: "2025-08-03", description: "Pelvic MRI follow-up, schematic T2", accession: "SYN-MR-2508", note: "Synthetic follow-up. Not registered to the earlier MRI." },
  { key: "aisha-mr1", patient: "aisha", modality: "MR", date: "2025-01-09", description: "Pelvic MRI", accession: "SYN-MR-E1", note: "Synthetic. Lesion coordinates are schematic." },
  { key: "aisha-mr2", patient: "aisha", modality: "MR", date: "2025-07-19", description: "Pelvic MRI, limited coverage", accession: "SYN-MR-E2", note: "Synthetic. Marked limited quality on purpose." },
  { key: "kavya-us", patient: "kavya", modality: "US", date: "2025-06-02", description: "Transvaginal ultrasound, morphology note", accession: "SYN-US-P1", note: "Synthetic morphology note. Not a diagnosis." },
  { key: "divya-us1", patient: "divya", modality: "US", date: "2025-03-01", description: "Pelvic ultrasound", accession: "SYN-US-C1", note: "Synthetic cyst measurement." },
  { key: "divya-us2", patient: "divya", modality: "US", date: "2025-09-01", description: "Pelvic ultrasound follow-up", accession: "SYN-US-C2", note: "Synthetic follow-up. Schematic frame only." },
] as const;

export const SERIES = [
  { key: "meera-mr1-s", study: "meera-mr1", n: 1, description: "Sagittal T2 schematic", plane: "sagittal", thick: 4, spacing: "0.7\\0.7", slices: 28, quality: "adequate" },
  { key: "meera-us-s", study: "meera-us", n: 1, description: "Uterus longitudinal", plane: "longitudinal", thick: null, spacing: null, slices: 1, quality: "adequate" },
  { key: "meera-mr2-s", study: "meera-mr2", n: 1, description: "Sagittal T2 schematic", plane: "sagittal", thick: 4, spacing: "0.7\\0.7", slices: 28, quality: "adequate" },
  { key: "aisha-mr1-s", study: "aisha-mr1", n: 1, description: "Axial T2 schematic", plane: "axial", thick: 3, spacing: "0.8\\0.8", slices: 32, quality: "adequate" },
  { key: "aisha-mr2-s", study: "aisha-mr2", n: 1, description: "Axial T2, partial pelvis", plane: "axial", thick: 4, spacing: "1.0\\1.0", slices: 18, quality: "limited" },
  { key: "kavya-us-s", study: "kavya-us", n: 1, description: "Ovary still frame", plane: "unspecified", thick: null, spacing: null, slices: 1, quality: "adequate" },
  { key: "divya-us1-s", study: "divya-us1", n: 1, description: "Left ovary", plane: "unspecified", thick: null, spacing: null, slices: 1, quality: "adequate" },
  { key: "divya-us2-s", study: "divya-us2", n: 1, description: "Left ovary", plane: "unspecified", thick: null, spacing: null, slices: 1, quality: "adequate" },
] as const;

export const REPORTS: { key: string; study: string; date: string; body: string }[] = [
  {
    key: "r-meera-mr1",
    study: "meera-mr1",
    date: "2024-11-12",
    body: "Synthetic report. Anterior intramural fibroid, described as FIGO 4, about 4.2 cm. A posterior subserosal fibroid is described as 3.4 cm. A smaller submucosal fibroid, FIGO 2, is described at about 1.8 cm. This text is fabricated for the prototype.",
  },
  {
    key: "r-meera-us",
    study: "meera-us",
    date: "2025-02-14",
    body: "Synthetic ultrasound note. The anterior fibroid is measured at 3.9 cm in a single plane. Other fibroids were not confidently separated on this study.",
  },
  {
    key: "r-meera-mr2",
    study: "meera-mr2",
    date: "2025-08-03",
    body: "Synthetic follow-up report. Anterior intramural fibroid about 5.1 cm. Posterior subserosal fibroid about 2.9 cm. The previously described submucosal fibroid is not identified. A separate right-sided pedunculated fibroid is described. Non-visualization is not confirmation that a fibroid has resolved.",
  },
  {
    key: "r-aisha-1",
    study: "aisha-mr1",
    date: "2025-01-09",
    body: "Synthetic report. A focus in the right uterosacral region is described, about 1.6 cm, of uncertain significance. A tiny separate peritoneal signal focus is noted. The report does not claim these prove endometriosis, and it does not claim the scan excludes it.",
  },
  {
    key: "r-aisha-2",
    study: "aisha-mr2",
    date: "2025-07-19",
    body: "Synthetic report. Coverage is limited. A right uterosacral focus is again described, similar in size, but the study is not registered to the earlier scan. The tiny peritoneal focus is not assessed.",
  },
  {
    key: "r-kavya",
    study: "kavya-us",
    date: "2025-06-02",
    body: "Synthetic note. Right ovary follicle count recorded as 14, left as 10, by the reporting clinician. This prototype does not apply a follicle threshold and does not diagnose PCOS.",
  },
  {
    key: "r-divya-1",
    study: "divya-us1",
    date: "2025-03-01",
    body: "Synthetic note. Left ovarian cyst measured 3.2 cm. The note describes it as simple-appearing. No risk score is added by this software.",
  },
  {
    key: "r-divya-2",
    study: "divya-us2",
    date: "2025-09-01",
    body: "Synthetic follow-up. Left ovarian cyst measured 3.6 cm in a similar descriptive category. The change is recorded, not interpreted.",
  },
];

export const FINDINGS: FindingSeed[] = [
  {
    key: "m1a", code: "F-01", patient: "meera", study: "meera-mr1", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 4 anterior intramural", figo: "4", centroid: [2, 8, 18], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "m1a-v1", source: "demonstration_geometry", modelId: "phantom-geometry-1", axes: [46, 40, 38], longest: 46, reportLongest: null, reason: "Initial demonstration envelope from the synthetic label. Not a trained model.", quote: null, slice: 14 },
      { key: "m1a-v2", source: "clinician_edit", modelId: null, axes: [42, 38, 36], longest: 42, reportLongest: 42, reason: "Boundary brought inside the junctional zone on the schematic slices 14–18.", quote: "Anterior intramural fibroid, described as FIGO 4, about 4.2 cm.", slice: 16 },
    ],
  },
  {
    key: "m1b", code: "F-02", patient: "meera", study: "meera-mr1", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 6 posterior subserosal", figo: "6", centroid: [4, -6, -22], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "m1b-v1", source: "clinician_recorded", modelId: null, axes: [28, 24, 22], longest: 28, reportLongest: 34, reason: "Entered from the synthetic report and schematic placement.", quote: "A posterior subserosal fibroid is described as 3.4 cm.", slice: 18 },
    ],
  },
  {
    key: "m1c", code: "F-03", patient: "meera", study: "meera-mr1", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 2 submucosal", figo: "2", centroid: [-3, 4, 6], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "m1c-v1", source: "clinician_recorded", modelId: null, axes: [18, 16, 15], longest: 18, reportLongest: 18, reason: "Small cavity-adjacent observation.", quote: "A smaller submucosal fibroid, FIGO 2, is described at about 1.8 cm.", slice: 15 },
    ],
  },
  {
    key: "mus", code: "F-01-US", patient: "meera", study: "meera-us", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 4 anterior intramural", figo: "4", centroid: null, frame: "unavailable", quality: "adequate", modality: "US", basis: "single-plane longest axis",
    versions: [
      { key: "mus-v1", source: "clinician_recorded", modelId: null, axes: null, longest: 39, reportLongest: 39, reason: "Ultrasound has no shared coordinate frame with MRI, so no centroid is stored.", quote: "The anterior fibroid is measured at 3.9 cm in a single plane.", slice: null },
    ],
  },
  {
    key: "m2a", code: "F-11", patient: "meera", study: "meera-mr2", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 4 anterior intramural", figo: "4", centroid: [3, 9, 17], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "m2a-v1", source: "demonstration_geometry", modelId: "phantom-geometry-1", axes: [51, 44, 40], longest: 51, reportLongest: 51, reason: "Follow-up demonstration envelope. Not registered to the earlier study.", quote: "Anterior intramural fibroid about 5.1 cm.", slice: 16 },
    ],
  },
  {
    key: "m2b", code: "F-12", patient: "meera", study: "meera-mr2", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 6 posterior subserosal", figo: "6", centroid: [5, -5, -21], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "m2b-v1", source: "clinician_recorded", modelId: null, axes: [29, 25, 22], longest: 29, reportLongest: 29, reason: "Follow-up schematic placement.", quote: "Posterior subserosal fibroid about 2.9 cm.", slice: 18 },
    ],
  },
  {
    key: "m2d", code: "F-14", patient: "meera", study: "meera-mr2", structure: "fibroid", organ: "uterus", pathway: "fibroids",
    location: "FIGO 7 pedunculated", figo: "7", centroid: [34, 10, -16], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "m2d-v1", source: "clinician_recorded", modelId: null, axes: [14, 12, 11], longest: 14, reportLongest: 14, reason: "Separate right-sided observation. Not automatically identified with earlier fibroids.", quote: "A separate right-sided pedunculated fibroid is described.", slice: 12 },
    ],
  },
  {
    key: "e1", code: "L-01", patient: "aisha", study: "aisha-mr1", structure: "endometriotic_lesion", organ: "pelvis", pathway: "endometriosis",
    location: "right uterosacral region", figo: null, centroid: [18, -4, 8], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "e1-v1", source: "clinician_recorded", modelId: null, axes: [16, 12, 10], longest: 16, reportLongest: 16, reason: "Visible focus only. Not a diagnosis of endometriosis.", quote: "A focus in the right uterosacral region is described, about 1.6 cm, of uncertain significance.", slice: 20 },
    ],
  },
  {
    key: "e1b", code: "L-02", patient: "aisha", study: "aisha-mr1", structure: "endometriotic_lesion", organ: "pelvis", pathway: "endometriosis",
    location: "peritoneal surface", figo: null, centroid: [-12, -8, 4], frame: "schematic", quality: "adequate", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "e1b-v1", source: "clinician_recorded", modelId: null, axes: [8, 6, 5], longest: 8, reportLongest: 8, reason: "Tiny focus. Non-visualization later must not be called resolution.", quote: "A tiny separate peritoneal signal focus is noted.", slice: 22 },
    ],
  },
  {
    key: "e2", code: "L-11", patient: "aisha", study: "aisha-mr2", structure: "endometriotic_lesion", organ: "pelvis", pathway: "endometriosis",
    location: "right uterosacral region", figo: null, centroid: [18, -4, 30], frame: "schematic", quality: "limited", modality: "MR", basis: "three-axis ellipsoid",
    versions: [
      { key: "e2-v1", source: "clinician_recorded", modelId: null, axes: [16, 12, 11], longest: 16, reportLongest: 16, reason: "Limited coverage. Not registered to the earlier study.", quote: "A right uterosacral focus is again described, similar in size, but the study is not registered to the earlier scan.", slice: 11 },
    ],
  },
  {
    key: "k-fol", code: "O-01", patient: "kavya", study: "kavya-us", structure: "follicle_count", organ: "ovary", pathway: "pcos",
    location: "both ovaries", figo: null, centroid: null, frame: "unavailable", quality: "adequate", modality: "US", basis: "clinician follicle count",
    versions: [
      { key: "k-fol-v1", source: "clinician_recorded", modelId: null, axes: null, longest: null, reportLongest: null, reason: "Count recorded by the reporting clinician. The software does not threshold it.", quote: "Right ovary follicle count recorded as 14, left as 10, by the reporting clinician.", slice: null },
    ],
  },
  {
    key: "c1", code: "C-01", patient: "divya", study: "divya-us1", structure: "cyst", organ: "ovary", pathway: "cyst",
    location: "left ovary", figo: null, centroid: [-40, 2, 6], frame: "schematic", quality: "adequate", modality: "US", basis: "three-axis ellipsoid",
    versions: [
      { key: "c1-v1", source: "clinician_recorded", modelId: null, axes: [32, 28, 26], longest: 32, reportLongest: 32, reason: "Simple-appearing description is the clinician's wording, not a software classification.", quote: "Left ovarian cyst measured 3.2 cm. The note describes it as simple-appearing.", slice: null },
    ],
  },
  {
    key: "c2", code: "C-11", patient: "divya", study: "divya-us2", structure: "cyst", organ: "ovary", pathway: "cyst",
    location: "left ovary", figo: null, centroid: [-38, 3, 7], frame: "schematic", quality: "adequate", modality: "US", basis: "three-axis ellipsoid",
    versions: [
      { key: "c2-v1", source: "clinician_recorded", modelId: null, axes: [36, 30, 28], longest: 36, reportLongest: 36, reason: "Follow-up measurement. No risk score.", quote: "Left ovarian cyst measured 3.6 cm in a similar descriptive category.", slice: null },
    ],
  },
];

export const SYMPTOMS = [
  { patient: "meera", date: "2025-07-28", region: "Lower abdomen — midline", intensity: 4, cycleDay: 2, description: "Heavy-day cramping. Patient-reported. Not linked as caused by a fibroid." },
  { patient: "meera", date: "2025-08-02", region: "Low back", intensity: 3, cycleDay: 7, description: "Dull backache the week after the bleed started." },
  { patient: "aisha", date: "2025-07-01", region: "Deep pelvis", intensity: 7, cycleDay: 18, description: "Deep pain with a bowel motion. Patient-reported. A nearby lesion is not evidence that it caused this." },
  { patient: "aisha", date: "2025-07-11", region: "Right lower quadrant", intensity: 6, cycleDay: null, description: "Right-sided pain, three evenings." },
  { patient: "kavya", date: "2025-09-14", region: "Lower abdomen — midline", intensity: 2, cycleDay: null, description: "Acne flare noted by the patient alongside a long cycle." },
  { patient: "divya", date: "2025-08-20", region: "Left lower quadrant", intensity: 3, cycleDay: 12, description: "Left-sided ache. Not attributed to the cyst by this record." },
];

export const CYCLES = [
  { patient: "kavya", start: "2025-04-02", length: 46, flow: "moderate", note: "Longer than her recent cycles." },
  { patient: "kavya", start: "2025-05-18", length: 33, flow: "light", note: "Shorter interval." },
  { patient: "kavya", start: "2025-06-20", length: 52, flow: "heavy", note: "Patient marked this as unpredictable." },
  { patient: "kavya", start: "2025-08-11", length: 29, flow: "moderate", note: "Closer to a monthly interval." },
  { patient: "kavya", start: "2025-09-09", length: 41, flow: "moderate", note: "Still irregular. Irregularity alone is not a diagnosis." },
  { patient: "meera", start: "2025-07-27", length: 30, flow: "heavy", note: "Heavy days. Not interpreted." },
  { patient: "aisha", start: "2025-06-30", length: 28, flow: "moderate", note: "Pain was worse mid-cycle, by her report." },
];

export const LABS = [
  { patient: "kavya", date: "2025-06-18", analyte: "Total testosterone", value: "1.9", unit: "nmol/L", ref: "lab range on the synthetic form: 0.3–1.7", note: "Value copied from a synthetic lab slip. Not interpreted here." },
  { patient: "kavya", date: "2025-06-18", analyte: "TSH", value: "1.8", unit: "mIU/L", ref: "synthetic form range 0.4–4.0", note: "Recorded so it is not forgotten. Not a diagnosis." },
  { patient: "kavya", date: "2025-06-18", analyte: "Fasting glucose", value: "5.4", unit: "mmol/L", ref: "synthetic form range 3.9–5.5", note: "Metabolic context only." },
  { patient: "kavya", date: "2025-06-18", analyte: "AMH", value: "38", unit: "pmol/L", ref: "no threshold applied", note: "The software does not convert AMH into a PCOS label." },
];

function latest(f: FindingSeed): VersionSeed {
  return f.versions[f.versions.length - 1];
}

export function snapsFor(patient: FindingSeed["patient"]): { studyId: string; date: string; snaps: Snap[] }[] {
  const studyDate = new Map<string, string>(STUDIES.map((s) => [s.key, s.date]));
  const groups = new Map<string, Snap[]>();
  for (const f of FINDINGS.filter((item) => item.patient === patient)) {
    const v = latest(f);
    const snap: Snap = {
      id: v.key,
      findingId: f.key,
      studyId: f.study,
      date: studyDate.get(f.study) ?? "",
      organ: f.organ,
      structure: f.structure,
      locationLabel: f.location,
      modality: f.modality,
      frame: f.frame,
      centroidMm: f.centroid,
      axesMm: v.axes,
      longestMm: v.longest,
      quality: f.quality,
    };
    const list = groups.get(f.study) ?? [];
    list.push(snap);
    groups.set(f.study, list);
  }
  return [...groups.entries()].map(([studyId, snaps]) => ({
    studyId,
    date: studyDate.get(studyId) ?? "",
    snaps,
  }));
}

export function proposalsFor(patient: FindingSeed["patient"]): Proposal[] {
  return matchChronology(snapsFor(patient));
}

function measureOf(f: FindingSeed, v: VersionSeed): Measure {
  const date = STUDIES.find((s) => s.key === f.study)?.date ?? "";
  return {
    id: v.key,
    findingId: f.key,
    date,
    modality: f.modality,
    basis: f.basis,
    locationLabel: f.location,
    longestMm: v.longest,
    axesMm: v.axes,
    source: v.source,
    reportLongestMm: v.reportLongest,
    quality: f.quality,
  };
}

export function discrepanciesFor(patient: FindingSeed["patient"]): Discrepancy[] {
  const findings = FINDINGS.filter((f) => f.patient === patient);
  const out: Discrepancy[] = [];
  const seen = new Set<string>();
  const push = (d: Discrepancy | null) => {
    if (!d) return;
    const k = `${d.category}|${d.leftRef}|${d.rightRef}|${d.summary}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(d);
  };
  for (const f of findings) {
    for (let i = 1; i < f.versions.length; i += 1) {
      push(segmentationGap(measureOf(f, f.versions[i - 1]), measureOf(f, f.versions[i])));
    }
    push(reportGap(measureOf(f, latest(f))));
  }
  const proposals = proposalsFor(patient);
  for (const p of proposals) {
    if (!p.fromId || !p.toId) continue;
    if (p.category !== "likely_same" && p.category !== "uncertain") continue;
    const a = findings.flatMap((f) => f.versions.map((v) => ({ f, v }))).find((x) => x.v.key === p.fromId);
    const b = findings.flatMap((f) => f.versions.map((v) => ({ f, v }))).find((x) => x.v.key === p.toId);
    if (!a || !b) continue;
    push(sameMethodChange(measureOf(a.f, a.v), measureOf(b.f, b.v)));
    if (p.category === "uncertain" && (a.f.quality !== "adequate" || b.f.quality !== "adequate")) {
      push({
        category: "unresolved_uncertainty",
        summary: "Correspondence is uncertain and image quality is limited",
        detail:
          "A size comparison is not offered as change over time while the match itself is uncertain and at least one study is limited.",
        leftRef: a.v.key,
        rightRef: b.v.key,
      });
    }
  }
  const latests = findings.map((f) => ({ f, v: latest(f) }));
  for (let i = 0; i < latests.length; i += 1) {
    for (let j = i + 1; j < latests.length; j += 1) {
      push(methodGap(measureOf(latests[i].f, latests[i].v), measureOf(latests[j].f, latests[j].v)));
    }
  }
  return out;
}

export const MODELS = [
  {
    id: "phantom-geometry-1",
    name: "Phantom geometry envelope",
    status: "demonstration",
    note: "Builds an ellipsoid label and a cuberille surface from stored axes. Not trained. No Dice or HD95 is reported.",
  },
  {
    id: "dicom-meta-1",
    name: "DICOM metadata reader",
    status: "active",
    note: "dicom-parser reads Part 10 headers in the browser. Uncompressed 8-bit grayscale can be drawn. Pixels are not saved on the server.",
  },
  {
    id: "external-nnunet",
    name: "nnU-Net / TotalSegmentator MRI adapter",
    status: "not_connected",
    note: "Reserved adapter. No weights are loaded and no prediction is shown.",
  },
  {
    id: "external-umd",
    name: "UMD myoma model adapter",
    status: "not_connected",
    note: "The public UMD dataset is the intended future training source. It was not downloaded and no model was trained.",
  },
] as const;
