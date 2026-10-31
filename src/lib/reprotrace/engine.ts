/** ReproTrace rules. Proposals only — nothing here merges findings. */

import type { RegistrationTransform } from "../imaging/registration.ts";
import { transformPoint } from "../imaging/registration.ts";

export const ENGINE_VERSION = "reprotrace-rules-1";

export type MatchCategory =
  | "likely_same"
  | "potentially_new"
  | "possible_resolved"
  | "uncertain"
  | "needs_review";

export type Frame = "image_registered" | "schematic" | "unavailable";

export type Snap = {
  id: string;
  findingId: string;
  studyId: string;
  date: string;
  organ: string;
  structure: string;
  locationLabel: string;
  modality: string;
  frame: Frame;
  centroidMm: [number, number, number] | null;
  axesMm: [number, number, number] | null;
  longestMm: number | null;
  quality: "adequate" | "limited" | "unknown";
};

export type Proposal = {
  fromId: string | null;
  toId: string | null;
  fromStudyId: string | null;
  toStudyId: string | null;
  category: MatchCategory;
  score: number;
  rationale: string;
  provisional: boolean;
};

const DIST_SAME = 18;
const DIST_FAR = 40;
const PAIR_FLOOR = 0.62;

export function longestOf(
  axes: [number, number, number] | null,
  longest: number | null,
): number | null {
  if (longest != null && Number.isFinite(longest)) return longest;
  if (!axes) return null;
  return Math.max(axes[0], axes[1], axes[2]);
}

export function ellipsoidVolumeMm3(axes: [number, number, number]): number {
  return (4 / 3) * Math.PI * (axes[0] / 2) * (axes[1] / 2) * (axes[2] / 2);
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function pairScore(a: Snap, b: Snap): { score: number; category: MatchCategory; notes: string[] } | null {
  if (a.organ !== b.organ || a.structure !== b.structure) return null;
  const notes: string[] = [];
  let score = 0.35;
  if (a.locationLabel && a.locationLabel === b.locationLabel) {
    score += 0.25;
    notes.push("same recorded anatomical label");
  } else if (a.locationLabel && b.locationLabel) {
    score -= 0.05;
    notes.push("anatomical labels differ");
  }
  let separation: number | null = null;
  if (a.centroidMm && b.centroidMm) {
    separation = dist(a.centroidMm, b.centroidMm);
    notes.push(`centroid separation ${separation.toFixed(1)} mm in the stored frame`);
    if (separation <= DIST_SAME) score += 0.3;
    else if (separation <= DIST_FAR) score += 0.1;
    else score -= 0.25;
  } else {
    score -= 0.2;
    notes.push("at least one observation has no centroid");
  }
  const la = longestOf(a.axesMm, a.longestMm);
  const lb = longestOf(b.axesMm, b.longestMm);
  if (la && lb && la > 0 && lb > 0) {
    const ratio = Math.max(la, lb) / Math.min(la, lb);
    notes.push(`longest-axis ratio ${ratio.toFixed(2)}`);
    if (ratio <= 1.35) score += 0.15;
    else if (ratio <= 1.8) score += 0.05;
    else score -= 0.1;
  }
  if (a.modality !== b.modality) {
    score -= 0.08;
    notes.push("modalities differ");
  }
  if (a.quality !== "adequate" || b.quality !== "adequate") {
    score -= 0.12;
    notes.push("image quality is limited or unknown on at least one study");
  }
  score = Math.max(0, Math.min(0.99, score));

  let category: MatchCategory = "needs_review";
  if (separation != null && separation <= DIST_SAME && score >= 0.72) category = "likely_same";
  else if (separation != null && separation <= DIST_FAR && score >= 0.45) category = "uncertain";
  else category = "needs_review";

  if (a.quality !== "adequate" || b.quality !== "adequate") {
    if (category === "likely_same") category = "uncertain";
  }
  if (!a.centroidMm || !b.centroidMm || a.frame === "unavailable" || b.frame === "unavailable") {
    category = "needs_review";
  }
  if (a.frame !== "image_registered" || b.frame !== "image_registered") {
    notes.push(
      "coordinate frame is schematic, not an image-to-image registration, so this cannot be confirmed automatically",
    );
  }
  return { score, category, notes };
}

/** Pair observations between two spatially described studies. Does not merge records. */
export function matchStudies(
  prior: Snap[],
  next: Snap[],
  registration?: { supported: boolean; transform?: RegistrationTransform } | null,
): Proposal[] {
  const candidates: {
    i: number;
    j: number;
    score: number;
    category: MatchCategory;
    notes: string[];
  }[] = [];
  let evaluatedNext = next;
  const priorRegistered = prior.map((p) => (registration?.supported ? { ...p, frame: "image_registered" as Frame } : p));
  if (registration?.supported && registration.transform) {
    const tx = registration.transform;
    evaluatedNext = next.map((s) => ({
      ...s,
      frame: "image_registered" as Frame,
      centroidMm: s.centroidMm ? transformPoint(s.centroidMm, tx) : null,
    }));
  }

  priorRegistered.forEach((a, i) => {
    evaluatedNext.forEach((b, j) => {
      const scored = pairScore(a, b);
      if (!scored || scored.score < PAIR_FLOOR) return;

      let cat = scored.category;
      const notes = [...scored.notes];

      if (registration) {
        if (registration.supported) {
          notes.push("Rigid follow-up image registration verified; spatial correspondence is supported");
        } else {
          notes.push("Follow-up image registration was attempted but spatial correspondence could not be established");
          if (cat === "likely_same") cat = "uncertain";
        }
      }

      candidates.push({ i, j, score: scored.score, category: cat, notes });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  const usedPrior = new Set<number>();
  const usedNext = new Set<number>();
  const proposals: Proposal[] = [];
  for (const c of candidates) {
    if (usedPrior.has(c.i) || usedNext.has(c.j)) continue;
    usedPrior.add(c.i);
    usedNext.add(c.j);
    const a = priorRegistered[c.i];
    const b = evaluatedNext[c.j];
    proposals.push({
      fromId: a.id,
      toId: b.id,
      fromStudyId: a.studyId,
      toStudyId: b.studyId,
      category: c.category,
      score: Number(c.score.toFixed(2)),
      rationale: `${c.notes.join(". ")}.`,
      provisional: a.frame !== "image_registered" || b.frame !== "image_registered" || (registration ? !registration.supported : false),
    });
  }
  prior.forEach((a, i) => {
    if (usedPrior.has(i)) return;
    const small = (longestOf(a.axesMm, a.longestMm) ?? 99) < 20;
    proposals.push({
      fromId: a.id,
      toId: null,
      fromStudyId: a.studyId,
      toStudyId: next[0]?.studyId ?? null,
      category: small ? "needs_review" : "possible_resolved",
      score: small ? 0.34 : 0.48,
      rationale: small
        ? "Not paired on the later study. Longest axis under 20 mm makes non-visualization unreliable, so this stays in review rather than being called resolved."
        : "No geometric counterpart met the pairing threshold on the later study. Non-visualization is not treated as proof of resolution.",
      provisional: true,
    });
  });
  next.forEach((b, j) => {
    if (usedNext.has(j)) return;
    proposals.push({
      fromId: null,
      toId: b.id,
      fromStudyId: prior[0]?.studyId ?? null,
      toStudyId: b.studyId,
      category: "potentially_new",
      score: 0.5,
      rationale:
        "No counterpart on the earlier study met the pairing threshold. This is a potential new observation, not a confirmed new lesion.",
      provisional: b.frame !== "image_registered",
    });
  });
  return proposals;
}

export type StudyGroup = { studyId: string; date: string; snaps: Snap[] };

/** Spatial match uses only observations that actually have a centroid. */
export function matchChronology(groups: StudyGroup[]): Proposal[] {
  const spatial = groups
    .map((g) => ({
      ...g,
      snaps: g.snaps.filter((s) => s.centroidMm && s.frame !== "unavailable"),
    }))
    .filter((g) => g.snaps.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: Proposal[] = [];
  for (let i = 1; i < spatial.length; i += 1) {
    out.push(...matchStudies(spatial[i - 1].snaps, spatial[i].snaps));
  }
  return out;
}

export type DiscCategory =
  | "measurable_difference"
  | "method_difference"
  | "segmentation_disagreement"
  | "reporting_inconsistency"
  | "unresolved_uncertainty";

export type Discrepancy = {
  category: DiscCategory;
  summary: string;
  detail: string;
  leftRef: string;
  rightRef: string;
};

export type Measure = {
  id: string;
  findingId: string;
  date: string;
  modality: string;
  basis: string;
  locationLabel: string;
  longestMm: number | null;
  axesMm: [number, number, number] | null;
  source: string;
  reportLongestMm: number | null;
  quality: string;
};

export function sameMethodChange(a: Measure, b: Measure): Discrepancy | null {
  if (a.longestMm == null || b.longestMm == null) return null;
  if (a.modality !== b.modality) return null;
  if (a.basis !== b.basis) {
    return {
      category: "unresolved_uncertainty",
      summary: "Same modality, different measurement basis",
      detail:
        "The lengths were not taken on the same recorded basis, so the numeric gap is not interpreted as growth or shrinkage.",
      leftRef: a.id,
      rightRef: b.id,
    };
  }
  const rel = Math.abs(a.longestMm - b.longestMm) / Math.min(a.longestMm, b.longestMm);
  if (rel <= 0.15) return null;
  return {
    category: "measurable_difference",
    summary: `Longest axis ${a.longestMm.toFixed(0)} mm (${a.date}) to ${b.longestMm.toFixed(0)} mm (${b.date})`,
    detail: `Relative change is ${(rel * 100).toFixed(0)}% where modality and measurement basis match. ReproTrace calls this a measurable difference only. It is not a determination of progression, response, or clinical significance.`,
    leftRef: a.id,
    rightRef: b.id,
  };
}

export function methodGap(a: Measure, b: Measure): Discrepancy | null {
  if (a.longestMm == null || b.longestMm == null) return null;
  if (a.modality === b.modality) return null;
  if (!a.locationLabel || a.locationLabel !== b.locationLabel) return null;
  return {
    category: "method_difference",
    summary: `${a.modality} ${a.longestMm.toFixed(0)} mm vs ${b.modality} ${b.longestMm.toFixed(0)} mm (${a.locationLabel})`,
    detail:
      "Different modalities are not treated as a before-and-after of one measurement. Plane, boundary definition, and resolution commonly move the number without a biological change being knowable from these two values alone.",
    leftRef: a.id,
    rightRef: b.id,
  };
}

export function segmentationGap(a: Measure, b: Measure): Discrepancy | null {
  if (a.findingId !== b.findingId || a.source === b.source) return null;
  if (!a.axesMm || !b.axesMm) return null;
  const va = ellipsoidVolumeMm3(a.axesMm);
  const vb = ellipsoidVolumeMm3(b.axesMm);
  const rel = Math.abs(va - vb) / Math.min(va, vb);
  if (rel <= 0.2) return null;
  return {
    category: "segmentation_disagreement",
    summary: "Stored geometry and a later edit disagree by more than 20% volume",
    detail: `Ellipsoid volumes differ by ${(rel * 100).toFixed(0)}% (${Math.round(va)} mm³ vs ${Math.round(vb)} mm³). The earlier version is kept. Demonstration geometry is not a trained model output.`,
    leftRef: a.id,
    rightRef: b.id,
  };
}

export function reportGap(m: Measure): Discrepancy | null {
  if (m.longestMm == null || m.reportLongestMm == null) return null;
  const delta = Math.abs(m.longestMm - m.reportLongestMm);
  if (delta <= 3) return null;
  return {
    category: "reporting_inconsistency",
    summary: `Report states ${m.reportLongestMm.toFixed(0)} mm; structured record states ${m.longestMm.toFixed(0)} mm`,
    detail:
      "The narrative measurement and the structured measurement disagree by more than 3 mm. Neither value is overwritten.",
    leftRef: m.id,
    rightRef: m.id,
  };
}

export type Explained = { text: string; source: string };

export function explainFinding(input: {
  structure: string;
  location: string;
  quote: string | null;
  axesMm: [number, number, number] | null;
  basis: string;
  verified: boolean;
  sourceName: string;
}): { paragraphs: Explained[]; insufficient: boolean } {
  const paragraphs: Explained[] = [];
  if (input.quote) {
    paragraphs.push({
      text: `The stored report says: “${input.quote}”`,
      source: "Clinical report excerpt stored with this finding",
    });
  }
  if (input.axesMm) {
    paragraphs.push({
      text: `The structured measurement kept for this version is ${input.axesMm.map((n) => n.toFixed(0)).join(" × ")} mm (${input.basis}), recorded at ${input.location}.`,
      source: input.sourceName,
    });
  } else {
    paragraphs.push({
      text: `A location is on file (${input.location}) but a three-axis measurement is not.`,
      source: input.sourceName,
    });
  }
  paragraphs.push({
    text: input.verified
      ? "A clinician review is attached to this version. That review does not by itself diagnose a condition or recommend treatment."
      : "This version has no clinician verification on file. It must not be read as a confirmed diagnosis.",
    source: "Review log",
  });
  paragraphs.push({
    text: "AnatomyBridge does not prescribe medication, recommend surgery, or infer malignancy from this record.",
    source: "Product safety policy",
  });
  return { paragraphs, insufficient: !input.quote };
}
