/**
 * Deterministic candidate scoring for linking an extracted report observation to an existing
 * anatomical finding version (ReproTrace Requirement 1).
 *
 * Pure: no database, no DOM, no randomness. The same inputs always give the same output.
 *
 * Rules (all thresholds are unvalidated prototype heuristics, see CANDIDATE_THRESHOLDS):
 * - Only findings of the same patient are ever considered.
 * - Hard incompatibilities (different organ or structure class, opposite laterality, conflicting FIGO type,
 *   contradictory location such as anterior vs posterior) exclude a candidate, even when it is the only one.
 * - Lengths are compared only with lengths and volumes only with volumes, after unit normalisation
 *   (cm -> mm, mL/cc -> mm³).
 * - The scorer never selects a candidate. `autoSelected` is always null: a clinician must confirm.
 */
import type { Extraction, ExtractedFinding, ExtractedMeasurement, Span } from "./extract.ts";

export const CANDIDATE_THRESHOLDS = {
  /** Minimum score for a compatible candidate to be shown as a plausible match. */
  plausible: 0.45,
  /** Minimum score for a "strong" candidate. */
  strong: 0.75,
  /** A second candidate within this margin of the best makes the result ambiguous. */
  ambiguityMargin: 0.15,
  isClinicallyValidated: false as const,
};

export type CandidateState = "strong" | "possible" | "ambiguous" | "none" | "insufficient_evidence";

export type StructureClass =
  | "fibroid"
  | "ovarian_cyst"
  | "endometrioma"
  | "endometriosis_lesion"
  | "follicles"
  | "adenomyosis"
  | "endometrium"
  | "other";

export type ObservationMeasurement = {
  text: string;
  dimension: "length" | "volume";
  /** Lengths in mm, or a single volume in mm³. */
  valuesNormalised: number[];
  unit: string;
  start: number;
  end: number;
};

export type ReportObservation = {
  /** Index of the observation in `extraction.findings`. */
  index: number;
  structure: string;
  structureClass: StructureClass;
  organ: string;
  laterality: "left" | "right" | "bilateral" | null;
  location: string | null;
  figo: string | null;
  negated: boolean;
  uncertain: boolean;
  sentence: Span;
  pageNumber: number;
  provenance: string;
  measurements: ObservationMeasurement[];
  /** Fields the parser derived rather than read verbatim (for display). */
  inferredFields: string[];
};

export type CandidateVersion = {
  versionId: string;
  findingId: string;
  findingCode: string;
  patientId: string;
  structure: string;
  organ: string;
  locationLabel: string;
  figo: string | null;
  studyId: string;
  studyDate: string | null;
  modality: string | null;
  versionNo: number;
  longestMm: number | null;
  axesMm: [number, number, number] | null;
  volumeMm3: number | null;
};

export type ScoredCandidate = {
  versionId: string;
  findingId: string;
  findingCode: string;
  score: number;
  compatible: boolean;
  reasons: string[];
  conflicts: string[];
};

export type CandidateAssessment = {
  state: CandidateState;
  candidates: ScoredCandidate[];
  explanation: string;
  /** Always null. Kept explicit so callers cannot mistake a top-ranked candidate for a decision. */
  autoSelected: null;
};

export function normalizeStructure(raw: string | null | undefined): StructureClass {
  const s = String(raw ?? "").toLowerCase().replace(/[_-]+/g, " ").trim();
  if (/\b(fibroids?|leiomyomas?|myomas?)\b/.test(s)) return "fibroid";
  if (/\bendometrioma|chocolate cyst/.test(s)) return "endometrioma";
  if (/\bendometrio(sis|tic)\b.*\b(lesion|nodule|focus)|\bendometriosis\b|\bdeep infiltrating\b/.test(s))
    return "endometriosis_lesion";
  if (/\bfollic/.test(s) || /\bpolycystic|pcom\b/.test(s)) return "follicles";
  if (/\badenomyosis\b/.test(s)) return "adenomyosis";
  if (/\bendometri(um|al)\b/.test(s)) return "endometrium";
  if (/\b(cysts?|cystadenoma|dermoid|cystic)\b/.test(s)) return "ovarian_cyst";
  return "other";
}

const RELATED_CLASSES: Array<[StructureClass, StructureClass]> = [["ovarian_cyst", "endometrioma"]];

function classRelation(a: StructureClass, b: StructureClass): "same" | "related" | "different" {
  if (a === b && a !== "other") return "same";
  if (RELATED_CLASSES.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return "related";
  return "different";
}

function organOf(structureClass: StructureClass, fallback: string): string {
  if (structureClass === "fibroid" || structureClass === "adenomyosis" || structureClass === "endometrium") return "uterus";
  if (structureClass === "ovarian_cyst" || structureClass === "endometrioma" || structureClass === "follicles") return "ovary";
  if (structureClass === "endometriosis_lesion") return "pelvis";
  return (fallback || "").toLowerCase();
}

export function lateralityOf(text: string | null | undefined): "left" | "right" | "bilateral" | null {
  const t = String(text ?? "").toLowerCase();
  if (/\b(bilateral|both ovaries|both adnexa)\b/.test(t)) return "bilateral";
  const l = /\bleft\b/.test(t);
  const r = /\bright\b/.test(t);
  if (l && !r) return "left";
  if (r && !l) return "right";
  return null;
}

const LOCATION_TOKENS = [
  "anterior",
  "posterior",
  "fundal",
  "cervical",
  "submucosal",
  "intramural",
  "subserosal",
  "pedunculated",
  "lateral",
  "uterosacral",
  "peritoneal",
  "isthmic",
] as const;
type LocationToken = (typeof LOCATION_TOKENS)[number];

const CONTRADICTORY_TOKENS: Array<[LocationToken, LocationToken]> = [
  ["anterior", "posterior"],
  ["fundal", "cervical"],
  ["submucosal", "subserosal"],
  ["submucosal", "pedunculated"],
];

export function locationTokens(text: string | null | undefined): Set<LocationToken> {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/\bfundus\b/g, "fundal")
    .replace(/\bcervix\b/g, "cervical");
  const out = new Set<LocationToken>();
  for (const tok of LOCATION_TOKENS) {
    if (new RegExp(`\\b${tok}\\b`).test(t)) out.add(tok);
  }
  return out;
}

/** "4", "2-5", "FIGO 4" -> set of integer types. */
export function figoTypes(raw: string | null | undefined): Set<number> {
  const out = new Set<number>();
  const nums = String(raw ?? "").match(/\d+/g) ?? [];
  for (const n of nums) {
    const v = Number(n);
    if (Number.isInteger(v) && v >= 0 && v <= 8) out.add(v);
  }
  return out;
}

function normaliseMeasurement(m: ExtractedMeasurement): ObservationMeasurement {
  if (m.dimension === "volume") {
    // Extracted volumes are already in mL (normalised); 1 mL = 1000 mm³.
    return {
      text: m.text,
      dimension: "volume",
      valuesNormalised: [m.normalised[0] * 1000],
      unit: m.unit,
      start: m.start,
      end: m.end,
    };
  }
  return {
    text: m.text,
    dimension: "length",
    valuesNormalised: [...m.normalised],
    unit: m.unit,
    start: m.start,
    end: m.end,
  };
}

/** Build a scoreable observation from one extracted finding sentence. */
export function observationFromExtraction(extraction: Extraction, index: number): ReportObservation | null {
  const f: ExtractedFinding | undefined = extraction.findings[index];
  if (!f) return null;
  const measurements = (f.measurementIndexes ?? [])
    .map((i) => extraction.measurements[i])
    .filter((m): m is ExtractedMeasurement => Boolean(m))
    .map(normaliseMeasurement);
  const structureClass = normalizeStructure(f.structure);
  const inferred: string[] = [];
  if (f.provenance === "parser_inferred") inferred.push("finding (uncertain wording or OCR text)");
  if (measurements.some((m) => m.dimension === "volume")) inferred.push("volume converted from mL to mm³");
  if (measurements.some((m) => m.unit === "cm")) inferred.push("lengths converted from cm to mm");
  return {
    index,
    structure: f.structure,
    structureClass,
    organ: organOf(structureClass, f.organ),
    laterality: f.laterality,
    location: f.anatomicalLocation ?? null,
    figo: f.figo,
    negated: f.negated,
    uncertain: Boolean(f.uncertain),
    sentence: f.sentence,
    pageNumber: f.pageNumber ?? f.sentence.pageNumber ?? 1,
    provenance: f.provenance ?? "explicitly_stated",
    measurements,
    inferredFields: inferred,
  };
}

function candidateVolumeMm3(c: CandidateVersion): number | null {
  if (c.volumeMm3 != null && Number.isFinite(c.volumeMm3) && c.volumeMm3 > 0) return c.volumeMm3;
  if (c.axesMm && c.axesMm.every((x) => Number.isFinite(x) && x > 0)) {
    return (4 / 3) * Math.PI * (c.axesMm[0] / 2) * (c.axesMm[1] / 2) * (c.axesMm[2] / 2);
  }
  return null;
}

function candidateLongestMm(c: CandidateVersion): number | null {
  if (c.longestMm != null && Number.isFinite(c.longestMm) && c.longestMm > 0) return c.longestMm;
  if (c.axesMm) return Math.max(...c.axesMm);
  return null;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function scoreCandidate(
  obs: ReportObservation,
  c: CandidateVersion,
  context: { reportStudyId: string | null; reportDate: string | null },
): ScoredCandidate {
  const reasons: string[] = [];
  const conflicts: string[] = [];
  let score = 0;

  const cClass = normalizeStructure(c.structure);
  const relation = classRelation(obs.structureClass, cClass);
  const cOrgan = organOf(cClass, c.organ);
  if (obs.organ && cOrgan && obs.organ !== cOrgan) {
    conflicts.push(`different organ (report: ${obs.organ}; record: ${cOrgan})`);
  }
  if (relation === "same") {
    score += 0.4;
    reasons.push(`same structure type (${cClass.replaceAll("_", " ")})`);
  } else if (relation === "related") {
    score += 0.2;
    reasons.push(`related structure type (${obs.structureClass.replaceAll("_", " ")} vs ${cClass.replaceAll("_", " ")})`);
  } else {
    conflicts.push(`different structure type (report: ${obs.structureClass.replaceAll("_", " ")}; record: ${cClass.replaceAll("_", " ")})`);
  }

  const cLat = lateralityOf(c.locationLabel);
  if (obs.laterality && cLat) {
    if (
      (obs.laterality === "left" && cLat === "right") ||
      (obs.laterality === "right" && cLat === "left")
    ) {
      conflicts.push(`opposite laterality (report: ${obs.laterality}; record: ${cLat})`);
    } else if (obs.laterality === cLat) {
      score += 0.1;
      reasons.push(`same laterality (${cLat})`);
    }
  } else if (obs.laterality || cLat) {
    reasons.push("laterality stated on only one side; not used");
  }

  const oFigo = figoTypes(obs.figo);
  const cFigo = figoTypes(c.figo);
  if (oFigo.size && cFigo.size) {
    const overlap = [...oFigo].some((t) => cFigo.has(t));
    if (overlap) {
      score += 0.15;
      reasons.push(`FIGO type agrees (${obs.figo} / ${c.figo})`);
    } else {
      conflicts.push(`FIGO type conflicts (report: ${obs.figo}; record: ${c.figo})`);
    }
  }

  const oTok = locationTokens(`${obs.location ?? ""} ${obs.sentence.text}`);
  const cTok = locationTokens(c.locationLabel);
  for (const [x, y] of CONTRADICTORY_TOKENS) {
    if ((oTok.has(x) && cTok.has(y)) || (oTok.has(y) && cTok.has(x))) {
      conflicts.push(`contradictory location (${oTok.has(x) ? x : y} vs ${cTok.has(x) ? x : y})`);
    }
  }
  const shared = [...oTok].filter((t) => cTok.has(t));
  if (shared.length) {
    score += Math.min(0.1, 0.05 * shared.length);
    reasons.push(`shared location terms: ${shared.join(", ")}`);
  }

  const sameStudy = Boolean(context.reportStudyId && context.reportStudyId === c.studyId);
  if (sameStudy) {
    score += 0.15;
    reasons.push("same examination as the report");
  } else if (c.studyDate) {
    reasons.push(`recorded on a different examination (${c.studyDate})`);
  }

  // Measurement comparison: like with like only.
  const lengths = obs.measurements.filter((m) => m.dimension === "length");
  const volumes = obs.measurements.filter((m) => m.dimension === "volume");
  const cLongest = candidateLongestMm(c);
  const cVolume = candidateVolumeMm3(c);
  let compared = false;
  if (lengths.length && cLongest) {
    const reported = Math.max(...lengths.flatMap((m) => m.valuesNormalised));
    const rel = Math.abs(reported - cLongest) / Math.max(reported, cLongest);
    compared = true;
    if (rel <= 0.15) {
      score += 0.15;
      reasons.push(`longest dimension agrees (${reported.toFixed(0)} mm vs ${cLongest.toFixed(0)} mm)`);
    } else if (rel <= 0.35) {
      score += 0.05;
      reasons.push(`longest dimension differs by ${pct(rel)} (${reported.toFixed(0)} mm vs ${cLongest.toFixed(0)} mm)`);
    } else if (sameStudy) {
      score -= 0.15;
      reasons.push(`longest dimension differs by ${pct(rel)} on the same examination (${reported.toFixed(0)} mm vs ${cLongest.toFixed(0)} mm)`);
    } else {
      reasons.push(`longest dimension differs by ${pct(rel)} across examinations; size change alone does not exclude a match`);
    }
  } else if (volumes.length && cVolume) {
    const reported = volumes[0].valuesNormalised[0];
    const rel = Math.abs(reported - cVolume) / Math.max(reported, cVolume);
    compared = true;
    if (rel <= 0.25) {
      score += 0.15;
      reasons.push(`volume agrees (${Math.round(reported)} mm³ vs ${Math.round(cVolume)} mm³)`);
    } else {
      reasons.push(`volume differs by ${pct(rel)} (${Math.round(reported)} mm³ vs ${Math.round(cVolume)} mm³)`);
    }
  }
  if (!compared && obs.measurements.length) {
    reasons.push(
      lengths.length
        ? "the record has no length measurement to compare"
        : "the report gives a volume but the record has no comparable volume; lengths and volumes are not compared",
    );
  }

  const compatible = conflicts.length === 0;
  return {
    versionId: c.versionId,
    findingId: c.findingId,
    findingCode: c.findingCode,
    score: Number(Math.max(0, Math.min(0.99, compatible ? score : 0)).toFixed(2)),
    compatible,
    reasons,
    conflicts,
  };
}

/**
 * Score every same-patient candidate and classify the overall situation. Candidates are returned
 * sorted (compatible first, then by score, then by finding code for determinism).
 */
export function assessReportObservation(
  obs: ReportObservation,
  candidates: CandidateVersion[],
  context: { patientId: string; reportStudyId: string | null; reportDate: string | null },
): CandidateAssessment {
  const scoped = candidates.filter((c) => c.patientId === context.patientId);
  const scored = scoped
    .map((c) => scoreCandidate(obs, c, context))
    .sort(
      (a, b) =>
        Number(b.compatible) - Number(a.compatible) ||
        b.score - a.score ||
        a.findingCode.localeCompare(b.findingCode) ||
        a.versionId.localeCompare(b.versionId),
    );

  if (obs.negated) {
    return {
      state: "insufficient_evidence",
      candidates: scored,
      explanation:
        "The report sentence negates this finding (for example 'no fibroid'). There is nothing to link to an anatomical finding.",
      autoSelected: null,
    };
  }

  const plausible = scored.filter((c) => c.compatible && c.score >= CANDIDATE_THRESHOLDS.plausible);
  const incompatible = scored.filter((c) => !c.compatible);
  const discriminating =
    Number(Boolean(obs.laterality)) +
    Number(Boolean(obs.location)) +
    Number(figoTypes(obs.figo).size > 0) +
    Number(obs.measurements.length > 0);

  if (plausible.length === 0) {
    const why = incompatible.length
      ? ` Rejected: ${incompatible
          .slice(0, 4)
          .map((c) => `${c.findingCode} (${c.conflicts.join("; ")})`)
          .join(" · ")}.`
      : scored.length === 0
        ? " This record has no anatomical findings yet."
        : " Compatible findings scored below the plausibility threshold.";
    return {
      state: "none",
      candidates: scored,
      explanation: `No suitable existing finding.${why} A provisional finding can be created, or the observation left unlinked.`,
      autoSelected: null,
    };
  }

  if (discriminating === 0) {
    return {
      state: "insufficient_evidence",
      candidates: scored,
      explanation:
        "The report names the structure but gives no side, location, FIGO type or size, so it cannot be told apart from other findings of the same type. Leave unlinked or choose explicitly with a note.",
      autoSelected: null,
    };
  }

  const best = plausible[0];
  const rivals = plausible.slice(1).filter((c) => c.score >= best.score - CANDIDATE_THRESHOLDS.ambiguityMargin);
  if (rivals.length > 0) {
    return {
      state: "ambiguous",
      candidates: scored,
      explanation: `${rivals.length + 1} findings are similarly compatible (${[best, ...rivals]
        .map((c) => `${c.findingCode} ${c.score.toFixed(2)}`)
        .join(", ")}). ReproCare does not choose between them; a clinician must confirm one, create a provisional finding, or leave this unlinked.`,
      autoSelected: null,
    };
  }

  if (best.score >= CANDIDATE_THRESHOLDS.strong && !obs.uncertain) {
    return {
      state: "strong",
      candidates: scored,
      explanation: `${best.findingCode} is a strong candidate: ${best.reasons.join("; ")}. Clinician confirmation is still required.`,
      autoSelected: null,
    };
  }

  return {
    state: "possible",
    candidates: scored,
    explanation: `${best.findingCode} is a possible candidate: ${best.reasons.join("; ")}.${obs.uncertain ? " The report wording is uncertain, so this cannot be a strong match." : ""} Clinician confirmation is required.`,
    autoSelected: null,
  };
}
