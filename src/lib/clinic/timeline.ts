/**
 * Pure read models over already-loaded workspace rows (Requirements 5, 6, 7):
 *  - buildPatientTimeline: examinations, findings, reports, symptoms, cycles, labs and clinician actions on
 *    one dated list, each item tagged with its source. Temporal proximity is shown, never interpreted.
 *  - buildFindingHistory: every version, evidence link, review, correspondence decision and discrepancy that
 *    touches one finding (and findings a clinician accepted as corresponding), oldest first.
 *  - buildEvidenceSummary: a finding version's information split into six explicit categories.
 * Nothing here creates, merges or infers clinical content.
 */
import { buildEvidenceChain, type EvidenceWorkspace } from "../reports/provenance.ts";

type Row = Record<string, unknown>;

export type TimelineWorkspace = EvidenceWorkspace & {
  patients?: Row[];
  symptoms: Row[];
  cycles: Row[];
  labs: Row[];
  correspondences: Row[];
  decisions: Row[];
  discrepancies: Row[];
  reviews: Row[];
  discrepancyReviewHistory?: Row[];
};

const str = (r: Row | undefined, k: string): string => {
  const v = r?.[k];
  if (v == null) return "";
  return v instanceof Date ? v.toISOString() : String(v);
};
const numOrNull = (r: Row | undefined, k: string): number | null => {
  const v = r?.[k];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (v: string): string => v.slice(0, 10);
const dayMs = (v: string): number | null => {
  const t = Date.parse(day(v));
  return Number.isFinite(t) ? t : null;
};

export type TimelineSource =
  | "imaging_examination"
  | "report"
  | "finding_record"
  | "patient_reported"
  | "laboratory_record"
  | "clinician_decision";

export type TimelineItem = {
  date: string;
  kind: "examination" | "report" | "finding" | "symptom" | "cycle" | "lab" | "decision" | "review";
  source: TimelineSource;
  title: string;
  detail: string;
  refId: string;
  synthetic: boolean;
  /** Examination ids within ±windowDays (shown as context only; no causal link). */
  nearExaminations: string[];
};

export const CONTEXT_WINDOW_DAYS = 30;

export function buildPatientTimeline(ws: TimelineWorkspace, patientId: string, windowDays = CONTEXT_WINDOW_DAYS): TimelineItem[] {
  const studies = ws.studies.filter((s) => str(s, "patient_id") === patientId);
  const findings = ws.findings.filter((f) => str(f, "patient_id") === patientId);
  const fIds = new Set(findings.map((f) => str(f, "id")));
  const versions = ws.versions.filter((v) => fIds.has(str(v, "finding_id")));
  const vIds = new Set(versions.map((v) => str(v, "id")));
  const studyIds = new Set(studies.map((s) => str(s, "id")));
  const near = (date: string): string[] => {
    const t = dayMs(date);
    if (t == null) return [];
    return studies
      .filter((s) => {
        const u = dayMs(str(s, "study_date"));
        return u != null && Math.abs(u - t) <= windowDays * 86400000;
      })
      .map((s) => str(s, "id"));
  };
  const items: TimelineItem[] = [];
  for (const s of studies)
    items.push({
      date: day(str(s, "study_date")),
      kind: "examination",
      source: "imaging_examination",
      title: `${str(s, "modality")} examination`,
      detail: str(s, "description"),
      refId: str(s, "id"),
      synthetic: s.synthetic === true,
      nearExaminations: [],
    });
  for (const r of ws.reports.filter((r) => studyIds.has(str(r, "study_id"))))
    items.push({
      date: day(str(r, "report_date")),
      kind: "report",
      source: "report",
      title: `Report (${str(r, "author_role") || "author not recorded"})`,
      detail: str(r, "body").replace(/\s+/g, " ").slice(0, 140),
      refId: str(r, "id"),
      synthetic: r.synthetic === true,
      nearExaminations: [],
    });
  for (const v of versions) {
    const f = findings.find((x) => str(x, "id") === str(v, "finding_id"));
    const longest = numOrNull(v, "longest_mm");
    items.push({
      date: day(str(v, "observed_on")),
      kind: "finding",
      source: "finding_record",
      title: `${str(f, "code")} v${str(v, "version_no")} · ${str(f, "structure")}`,
      detail: `${str(v, "location_label")}${longest != null ? ` · longest ${longest} mm` : ""} · basis: ${str(v, "measurement_basis") || "not recorded"} · source: ${str(v, "segmentation_source") || "not recorded"}`,
      refId: str(v, "id"),
      synthetic: /synthetic/i.test(str(v, "segmentation_source")) || /SYNTHETIC/.test(str(v, "change_reason")),
      nearExaminations: [],
    });
  }
  for (const s of ws.symptoms.filter((x) => str(x, "patient_id") === patientId))
    items.push({
      date: day(str(s, "recorded_on")),
      kind: "symptom",
      source: "patient_reported",
      title: `Symptom · ${str(s, "region")} · intensity ${str(s, "intensity")}/10${s.cycle_day != null ? ` · cycle day ${str(s, "cycle_day")}` : ""}`,
      detail: str(s, "description"),
      refId: str(s, "id"),
      synthetic: /SYNTHETIC/.test(str(s, "description")),
      nearExaminations: near(str(s, "recorded_on")),
    });
  for (const c of ws.cycles.filter((x) => str(x, "patient_id") === patientId))
    items.push({
      date: day(str(c, "start_date")),
      kind: "cycle",
      source: "patient_reported",
      title: `Period started${c.length_days != null ? ` · cycle ${str(c, "length_days")} d` : ""}${c.flow ? ` · flow ${str(c, "flow")}` : ""}`,
      detail: str(c, "note"),
      refId: str(c, "id"),
      synthetic: /SYNTHETIC/.test(str(c, "note")),
      nearExaminations: near(str(c, "start_date")),
    });
  for (const l of ws.labs.filter((x) => str(x, "patient_id") === patientId))
    items.push({
      date: day(str(l, "observed_on")),
      kind: "lab",
      source: "laboratory_record",
      title: `${str(l, "analyte")} ${str(l, "value_text")} ${str(l, "unit")}`,
      detail: `${l.reference_text ? `reference ${str(l, "reference_text")} · ` : ""}${str(l, "source_note")}`,
      refId: str(l, "id"),
      synthetic: /SYNTHETIC/.test(str(l, "source_note")),
      nearExaminations: near(str(l, "observed_on")),
    });
  const corrIds = new Set(
    ws.correspondences.filter((c) => vIds.has(str(c, "from_version_id")) || vIds.has(str(c, "to_version_id"))).map((c) => str(c, "id")),
  );
  for (const d of ws.decisions.filter((x) => corrIds.has(str(x, "correspondence_id"))))
    items.push({
      date: day(str(d, "created_at")),
      kind: "decision",
      source: "clinician_decision",
      title: `Correspondence decision: ${str(d, "decision")}`,
      detail: str(d, "note"),
      refId: str(d, "id"),
      synthetic: false,
      nearExaminations: [],
    });
  const order: Record<TimelineItem["kind"], number> = { examination: 0, report: 1, finding: 2, symptom: 3, cycle: 4, lab: 5, decision: 6, review: 7 };
  return items.sort((a, b) => (a.date === b.date ? order[a.kind] - order[b.kind] : a.date < b.date ? -1 : 1));
}

export type HistoryEvent = {
  at: string;
  kind: "version" | "evidence" | "review" | "correspondence" | "decision" | "discrepancy" | "discrepancy_review";
  findingId: string;
  versionId: string | null;
  title: string;
  detail: string;
  refId: string;
};

/**
 * History of one finding. Findings joined by an ACCEPTED correspondence are listed as related, and their
 * versions are included with their own finding id: nothing is merged, each keeps its own records.
 */
export function buildFindingHistory(ws: TimelineWorkspace, findingId: string): { relatedFindingIds: string[]; events: HistoryEvent[] } {
  const versionsOf = (fid: string) => ws.versions.filter((v) => str(v, "finding_id") === fid);
  const findingOfVersion = (vid: string) => str(ws.versions.find((v) => str(v, "id") === vid), "finding_id");
  // Related findings: follow accepted decisions (latest decision per correspondence wins).
  const latestDecision = new Map<string, Row>();
  for (const d of ws.decisions) latestDecision.set(str(d, "correspondence_id"), d);
  const related = new Set<string>([findingId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of ws.correspondences) {
      if (str(latestDecision.get(str(c, "id")), "decision") !== "accept") continue;
      const a = findingOfVersion(str(c, "from_version_id"));
      const b = findingOfVersion(str(c, "to_version_id"));
      if (!a || !b) continue;
      if (related.has(a) !== related.has(b)) {
        related.add(a);
        related.add(b);
        grew = true;
      }
    }
  }
  const events: HistoryEvent[] = [];
  const vIds = new Set<string>();
  for (const fid of related)
    for (const v of versionsOf(fid)) {
      const vid = str(v, "id");
      vIds.add(vid);
      const longest = numOrNull(v, "longest_mm");
      events.push({
        at: str(v, "created_at") || str(v, "observed_on"),
        kind: "version",
        findingId: fid,
        versionId: vid,
        title: `v${str(v, "version_no")} observed ${day(str(v, "observed_on"))}${longest != null ? ` · longest ${longest} mm` : ""}`,
        detail: `${str(v, "location_label")} · ${str(v, "change_reason")}${v.previous_version_id ? ` · supersedes ${str(v, "previous_version_id")}` : ""}`,
        refId: vid,
      });
    }
  for (const e of ws.evidence.filter((x) => vIds.has(str(x, "finding_version_id"))))
    events.push({
      at: str(e, "created_at"),
      kind: "evidence",
      findingId: findingOfVersion(str(e, "finding_version_id")),
      versionId: str(e, "finding_version_id"),
      title: `Evidence: ${str(e, "kind")}${e.link_status ? ` · ${str(e, "link_status")}` : ""}${e.review_status ? ` · ${str(e, "review_status")}` : ""}`,
      detail: e.quote ? `“${str(e, "quote")}”` : str(e, "note"),
      refId: str(e, "id"),
    });
  for (const r of ws.reviews.filter((x) => str(x, "target_type") === "finding_version" && vIds.has(str(x, "target_id"))))
    events.push({
      at: str(r, "created_at"),
      kind: "review",
      findingId: findingOfVersion(str(r, "target_id")),
      versionId: str(r, "target_id"),
      title: `Verification: ${str(r, "status")}`,
      detail: str(r, "note"),
      refId: str(r, "id"),
    });
  const corrs = ws.correspondences.filter((c) => vIds.has(str(c, "from_version_id")) || vIds.has(str(c, "to_version_id")));
  for (const c of corrs) {
    events.push({
      at: str(c, "created_at"),
      kind: "correspondence",
      findingId,
      versionId: null,
      title: `Proposal: ${str(c, "category")}${c.provisional === true ? " (provisional)" : ""} · ${str(c, "origin") || "origin not recorded"}`,
      detail: str(c, "rationale"),
      refId: str(c, "id"),
    });
    for (const d of ws.decisions.filter((x) => str(x, "correspondence_id") === str(c, "id")))
      events.push({
        at: str(d, "created_at"),
        kind: "decision",
        findingId,
        versionId: null,
        title: `Clinician decision: ${str(d, "decision")}`,
        detail: `${str(d, "note")}${d.engine_version ? ` · engine ${str(d, "engine_version")}` : ""}`,
        refId: str(d, "id"),
      });
  }
  for (const d of ws.discrepancies.filter((x) => vIds.has(str(x, "left_ref")) || vIds.has(str(x, "right_ref"))))
    events.push({
      at: str(d, "created_at"),
      kind: "discrepancy",
      findingId,
      versionId: null,
      title: `Discrepancy: ${str(d, "attribution_category") || str(d, "category")}`,
      detail: `${str(d, "summary")} — ${str(d, "detail")}`,
      refId: str(d, "id"),
    });
  for (const r of (ws.discrepancyReviewHistory ?? []).filter((x) => vIds.has(str(x, "left_ref")) || vIds.has(str(x, "right_ref"))))
    events.push({
      at: str(r, "created_at"),
      kind: "discrepancy_review",
      findingId,
      versionId: null,
      title: `Discrepancy review: ${str(r, "status")}`,
      detail: str(r, "note"),
      refId: str(r, "id"),
    });
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { relatedFindingIds: [...related].filter((f) => f !== findingId), events };
}

export type SummaryItem = { text: string; source: string; ref: string | null };
export type EvidenceSummary = {
  versionId: string;
  clinicianVerified: SummaryItem[];
  patientReported: SummaryItem[];
  extractedStatements: SummaryItem[];
  algorithmSuggestions: SummaryItem[];
  unresolvedDiscrepancies: SummaryItem[];
  missingEvidence: SummaryItem[];
};

const ALGORITHMIC_SOURCES = /(auto|threshold|region|classical|ai|model|unet|nnunet|segment)/i;

/** Six explicit information categories for one finding version (Req 7.2). */
export function buildEvidenceSummary(ws: TimelineWorkspace, versionId: string, windowDays = CONTEXT_WINDOW_DAYS): EvidenceSummary {
  const v = ws.versions.find((x) => str(x, "id") === versionId);
  const f = ws.findings.find((x) => str(x, "id") === str(v, "finding_id"));
  const pid = str(f, "patient_id");
  const chain = buildEvidenceChain(ws, versionId);
  const out: EvidenceSummary = {
    versionId,
    clinicianVerified: [],
    patientReported: [],
    extractedStatements: [],
    algorithmSuggestions: [],
    unresolvedDiscrepancies: [],
    missingEvidence: chain.gaps.map((g) => ({ text: g, source: "evidence chain", ref: null })),
  };
  for (const r of ws.reviews.filter((x) => str(x, "target_type") === "finding_version" && str(x, "target_id") === versionId && str(x, "status") === "verified"))
    out.clinicianVerified.push({ text: `Finding version verified: ${str(r, "note")}`, source: `review ${day(str(r, "created_at"))}`, ref: str(r, "id") });
  for (const l of chain.reportLinks) {
    const item = { text: `“${l.quote}”`, source: `report ${l.reportDate ?? ""} · p.${l.pageNumber ?? "?"} · chars ${l.quoteStart ?? "?"}–${l.quoteEnd ?? "?"}`, ref: l.evidenceId };
    if (l.reviewStatus === "clinician_verified") out.clinicianVerified.push({ ...item, text: `Report statement linked by clinician: ${item.text}` });
    else out.extractedStatements.push(item);
  }
  const latestDecision = new Map<string, Row>();
  for (const d of ws.decisions) latestDecision.set(str(d, "correspondence_id"), d);
  for (const c of ws.correspondences.filter((x) => str(x, "from_version_id") === versionId || str(x, "to_version_id") === versionId)) {
    const d = latestDecision.get(str(c, "id"));
    const text = `${str(c, "category").replaceAll("_", " ")} (score ${str(c, "score") || "—"}${c.provisional === true ? ", provisional" : ""}): ${str(c, "rationale")}`;
    if (d && str(d, "decision") === "accept") out.clinicianVerified.push({ text: `Correspondence accepted: ${text}`, source: `decision ${day(str(d, "created_at"))}`, ref: str(d, "id") });
    else out.algorithmSuggestions.push({ text, source: `rule-based engine ${str(c, "engine_version")}${d ? ` · clinician: ${str(d, "decision")}` : " · not reviewed"}`, ref: str(c, "id") });
  }
  const seg = str(v, "segmentation_source");
  if (seg && ALGORITHMIC_SOURCES.test(seg) && !/ground_truth/.test(seg))
    out.algorithmSuggestions.push({ text: `Measurement from ${seg}${str(v, "model_id") ? ` (${str(v, "model_id")})` : ""}`, source: "algorithm output", ref: versionId });
  if (/ground_truth|synthetic/i.test(seg))
    out.missingEvidence.push({ text: "Geometry is SYNTHETIC generator ground truth, not a measurement on real imaging.", source: seg, ref: versionId });
  const history = ws.discrepancyReviewHistory ?? [];
  for (const d of ws.discrepancies.filter((x) => str(x, "left_ref") === versionId || str(x, "right_ref") === versionId)) {
    const reviewed = [...history].reverse().find((r) => str(r, "left_ref") === str(d, "left_ref") && str(r, "right_ref") === str(d, "right_ref"));
    const status = reviewed ? str(reviewed, "status") : (ws.reviews.filter((r) => str(r, "target_id") === str(d, "id")).at(-1)?.status as string | undefined);
    const text = `${str(d, "summary")}: ${str(d, "detail")}`;
    if (status === "verified") out.clinicianVerified.push({ text: `Discrepancy attribution confirmed: ${text}`, source: "clinician review", ref: str(d, "id") });
    else if (status === "rejected") continue;
    else out.unresolvedDiscrepancies.push({ text, source: `rule-based attribution${status ? ` · ${status}` : " · not reviewed"}`, ref: str(d, "id") });
  }
  const t = dayMs(str(v, "observed_on"));
  const within = (date: string) => {
    const u = dayMs(date);
    return t != null && u != null && Math.abs(u - t) <= windowDays * 86400000;
  };
  for (const s of ws.symptoms.filter((x) => str(x, "patient_id") === pid && within(str(x, "recorded_on"))))
    out.patientReported.push({ text: `${str(s, "description")} (intensity ${str(s, "intensity")}/10)`, source: `patient-reported ${day(str(s, "recorded_on"))}`, ref: str(s, "id") });
  for (const c of ws.cycles.filter((x) => str(x, "patient_id") === pid && within(str(x, "start_date"))))
    out.patientReported.push({ text: `Period started${c.flow ? `, flow ${str(c, "flow")}` : ""}`, source: `patient-reported ${day(str(c, "start_date"))}`, ref: str(c, "id") });
  for (const l of ws.labs.filter((x) => str(x, "patient_id") === pid && within(str(x, "observed_on"))))
    out.patientReported.push({ text: `${str(l, "analyte")} ${str(l, "value_text")} ${str(l, "unit")}`, source: `laboratory record ${day(str(l, "observed_on"))} (not patient-reported)`, ref: str(l, "id") });
  if (!chain.reportLinks.length) out.missingEvidence.push({ text: "No report statement is linked to this finding version.", source: "evidence chain", ref: null });
  return out;
}
