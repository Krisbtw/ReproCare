/**
 * ReproTrace Requirement 1 + 2 panels: evidence trail, report-observation linker, correspondence review.
 * Reuses the app's existing tokens (pine / clay / ink / paper / line). No new design system.
 */
import { useMemo, useState, type ReactNode } from "react";
import type { Workspace } from "@/lib/clinic/types";
import type { Extraction } from "@/lib/reports/extract";
import { buildEvidenceChain } from "@/lib/reports/provenance";
import {
  CONTEXT_WINDOW_DAYS,
  buildEvidenceSummary,
  buildFindingHistory,
  buildPatientTimeline,
  type EvidenceSummary,
  type HistoryEvent,
  type TimelineSource,
  type TimelineWorkspace,
} from "@/lib/clinic/timeline";
import {
  assessReportObservation,
  observationFromExtraction,
  type CandidateVersion,
} from "@/lib/reports/candidates";
import { DEMO_EXAMS, DEMO_PATIENT_KEY, DEMO_REPORTS } from "@/lib/clinic/reprotrace-demo";

type Bag = Record<string, unknown>;
const s = (r: object | undefined, k: string) => {
  const v = r ? (r as Bag)[k] : undefined;
  return v == null ? "" : String(v);
};
const n = (r: object | undefined, k: string) => {
  const v = r ? (r as Bag)[k] : undefined;
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function Chip({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "pine" | "clay" }) {
  const cls = tone === "pine" ? "bg-pine-soft text-pine" : tone === "clay" ? "bg-clay-soft text-clay" : "bg-paper text-ink-soft";
  return <span className={`inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}
function Btn({ children, onClick, tone = "pine", disabled, testId }: { children: ReactNode; onClick?: () => void; tone?: "pine" | "clay" | "ghost"; disabled?: boolean; testId?: string }) {
  const cls = tone === "ghost" ? "border border-line bg-card text-ink" : tone === "clay" ? "bg-clay text-card" : "bg-pine text-card";
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className={`min-h-11 rounded-md px-3 text-sm font-medium ${cls} disabled:opacity-50`}>
      {children}
    </button>
  );
}

export const isDemoPatient = (patientId: string) => patientId.endsWith(`:${DEMO_PATIENT_KEY}`);
export function demoExamKeyForStudy(studyId: string): string | null {
  return DEMO_EXAMS.find((e) => studyId.endsWith(`:${e.key}`))?.key ?? null;
}

const SPATIAL_LABEL: Record<string, { text: string; tone: "pine" | "clay" | "ink" }> = {
  spatially_anchored: { text: "Spatially anchored (DICOM LPS)", tone: "pine" },
  schematic_only: { text: "Schematic coordinates only — not a spatial anchor", tone: "clay" },
  no_coordinates: { text: "Report link, no verified imaging anchor", tone: "clay" },
  coordinates_without_image: { text: "Coordinates without a linked source series", tone: "clay" },
};

const REVIEW_LABEL: Record<string, string> = {
  verified: "Attribution confirmed",
  rejected: "Attribution rejected",
  needs_more_information: "Further review",
};
const REVIEW_ACTION = { verified: "Confirm attribution", rejected: "Reject attribution", needs_more_information: "Mark for further review" } as const;
const DEFAULT_REVIEW_NOTE = {
  verified: "Clinician agrees with the proposed attribution.",
  rejected: "Clinician disagrees with the proposed attribution.",
  needs_more_information: "More evidence needed before attributing this difference.",
} as const;

/** Requirement 1: navigable source evidence for one finding version. */
export function EvidenceTrail({
  data,
  versionId,
  onOpenReport,
  onOpenSlice,
}: {
  data: Workspace;
  versionId: string;
  onOpenReport: (reportId: string, start: number | null, end: number | null) => void;
  onOpenSlice: (versionId: string, studyId: string, seriesId: string, slice: number | null, demoExamKey: string | null) => void;
}) {
  const chain = buildEvidenceChain(data as never, versionId);
  const spatial = SPATIAL_LABEL[chain.spatialStatus];
  const demoKey = chain.study ? demoExamKeyForStudy(chain.study.id) : null;
  return (
    <article className="space-y-2 rounded-lg border border-line bg-card p-4" data-testid="evidence-trail">
      <h2 className="text-xl">Evidence trail</h2>
      <div className="flex flex-wrap gap-2">
        <Chip tone={spatial.tone}>{spatial.text}</Chip>
        <Chip tone={chain.verificationStatus === "clinician_verified" ? "pine" : "clay"}>
          {chain.verificationStatus === "clinician_verified" ? "Report link clinician-verified" : "Needs review"}
        </Chip>
      </div>
      <ol className="space-y-1 text-sm text-ink-soft">
        {chain.reportLinks.map((r) => (
          <li key={r.evidenceId}>
            <span className="text-muted">Report {r.reportDate ?? ""} · p.{r.pageNumber ?? "?"} · chars {r.quoteStart ?? "?"}–{r.quoteEnd ?? "?"}{r.quoteVerified ? " · quote verified" : ""}</span>
            <span className="block text-ink">“{r.quote}”</span>
            <Btn tone="ghost" onClick={() => onOpenReport(r.reportId, r.quoteStart, r.quoteEnd)}>Open report at quote</Btn>
          </li>
        ))}
        <li>Finding {chain.findingCode ?? "?"} · version v{chain.versionNo ?? "?"}</li>
        <li>Examination: {chain.study ? `${chain.study.date} · ${chain.study.modality}${chain.study.studyInstanceUid ? ` · StudyUID …${chain.study.studyInstanceUid.slice(-10)}` : ""}` : "not linked"}</li>
        <li>Series: {chain.series ? `${chain.series.description ?? ""}${chain.series.seriesInstanceUid ? ` · SeriesUID …${chain.series.seriesInstanceUid.slice(-10)}` : ""}${chain.series.frameOfReferenceUid ? ` · FoR …${chain.series.frameOfReferenceUid.slice(-6)}` : ""}` : "not linked"}</li>
        <li>Source image: {chain.imageAnchor ? `slice ${chain.imageAnchor.sliceIndex ?? "?"}${chain.imageAnchor.sopInstanceUid ? ` · SOP …${chain.imageAnchor.sopInstanceUid.slice(-8)}` : ""}` : "not recorded"}</li>
        <li>Patient-space position: {chain.imageAnchor?.centroidLps ? `[${chain.imageAnchor.centroidLps.map((x) => x.toFixed(1)).join(", ")}] mm (${chain.imageAnchor.coordinateFrame})` : "none stored"}</li>
        <li>Registrations touching this series: {chain.registrationIds.length || "none"}</li>
      </ol>
      {chain.study && chain.series ? (
        <div className="space-y-1">
          <Btn tone="ghost" testId="open-source-slice" onClick={() => onOpenSlice(versionId, chain.study!.id, chain.series!.id, chain.imageAnchor?.sliceIndex ?? null, demoKey)}>
            Open original DICOM in Volume lab
          </Btn>
          <p className="text-xs text-muted">
            Retrieves the stored instances through authorized, SHA-256-verified storage. If none were uploaded, the lab says so{demoKey ? " (synthetic demo: falls back to a labelled regeneration)" : ""}.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted">No source series is recorded for this finding version, so there is no original image to open.</p>
      )}
      {chain.gaps.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-clay">{chain.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      )}
    </article>
  );
}

/** Requirement 1: per-observation candidate review inside an opened report. */
export function ObservationLinker({
  data,
  patientId,
  report,
  extraction,
  clinician,
  busy,
  onResolve,
  onFocusQuote,
}: {
  data: Workspace;
  patientId: string;
  report: Bag;
  extraction: Extraction;
  clinician: boolean;
  busy: boolean;
  onResolve: (input: { reportId: string; observationIndex: number; decision: "link_existing" | "create_provisional" | "leave_unlinked"; targetVersionId?: string | null; note: string }) => void;
  onFocusQuote: (start: number, end: number) => void;
}) {
  const [note, setNote] = useState("Checked against the source sentence and the recorded finding.");
  const candidates: CandidateVersion[] = useMemo(() => {
    const findings = (data.findings as Bag[]).filter((f) => s(f, "patient_id") === patientId);
    const latest = new Map<string, Bag>();
    for (const v of data.versions as unknown as Bag[]) {
      if (!findings.some((f) => s(f, "id") === s(v, "finding_id"))) continue;
      const cur = latest.get(s(v, "finding_id"));
      if (!cur || (n(v, "version_no") ?? 0) > (n(cur, "version_no") ?? 0)) latest.set(s(v, "finding_id"), v);
    }
    return [...latest.values()].map((v) => {
      const f = findings.find((x) => s(x, "id") === s(v, "finding_id"));
      const axes = (v as Bag).axes_mm as [number, number, number] | null;
      return {
        versionId: s(v, "id"),
        findingId: s(v, "finding_id"),
        findingCode: s(f, "code"),
        patientId,
        structure: s(f, "structure"),
        organ: s(f, "organ"),
        locationLabel: s(v, "location_label"),
        figo: s(v, "figo") || null,
        studyId: s(v, "study_id"),
        studyDate: s(v, "observed_on") || null,
        modality: s(v, "modality") || null,
        versionNo: n(v, "version_no") ?? 1,
        longestMm: n(v, "longest_mm"),
        axesMm: Array.isArray(axes) ? axes : null,
        volumeMm3: n(v, "volume_mm3"),
      };
    });
  }, [data.findings, data.versions, patientId]);
  const decisions = (data.observationLinks ?? []).filter((d) => s(d, "report_id") === s(report, "id"));
  const items = extraction.findings
    .map((_, i) => observationFromExtraction(extraction, i))
    .filter((o): o is NonNullable<typeof o> => Boolean(o));

  return (
    <section className="space-y-3 rounded-md border border-line p-3" data-testid="observation-linker">
      <h3 className="text-lg">Link extracted observations to anatomical findings</h3>
      <p className="text-xs text-muted">Candidates are scored deterministically (structure, organ, side, location, FIGO, size in like units, examination). Nothing is linked without a clinician decision. Thresholds are unvalidated prototype heuristics.</p>
      {clinician && (
        <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Review note" />
      )}
      {items.map((o) => {
        const a = assessReportObservation(o, candidates, { patientId, reportStudyId: s(report, "study_id"), reportDate: s(report, "report_date") || null });
        const last = [...decisions].reverse().find((d) => n(d, "observation_index") === o.index);
        const tone = a.state === "strong" ? "pine" : a.state === "none" || a.state === "insufficient_evidence" ? "ink" : "clay";
        return (
          <article key={o.index} className="space-y-2 rounded-sm border border-line bg-card p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={tone}>{`candidate: ${a.state.replaceAll("_", " ")}`}</Chip>
              <Chip>{o.structure}</Chip>
              {o.laterality && <Chip>{o.laterality}</Chip>}
              {o.figo && <Chip tone="pine">{`FIGO ${o.figo} (as written)`}</Chip>}
              <Chip>{`p.${o.pageNumber} · chars ${o.sentence.start}–${o.sentence.end}`}</Chip>
              <Chip tone={o.provenance === "explicitly_stated" ? "pine" : "clay"}>{o.provenance.replaceAll("_", " ")}</Chip>
              {o.negated && <Chip>negated</Chip>}
              {o.uncertain && <Chip tone="clay">uncertain wording</Chip>}
              {last && <Chip tone="pine">{`decided: ${s(last, "decision").replaceAll("_", " ")}`}</Chip>}
            </div>
            <button type="button" className="text-left text-ink" onClick={() => onFocusQuote(o.sentence.start, o.sentence.end)} title="Highlight in report">“{o.sentence.text}”</button>
            {o.measurements.length > 0 && (
              <p className="text-xs text-muted">Measurements: {o.measurements.map((m) => `${m.text} → ${m.dimension === "length" ? `${m.valuesNormalised.map((x) => x.toFixed(0)).join(" × ")} mm` : `${Math.round(m.valuesNormalised[0])} mm³`}`).join("; ")}{o.inferredFields.length ? ` · parser-derived: ${o.inferredFields.join(", ")}` : ""}</p>
            )}
            <p className="text-xs text-ink-soft">{a.explanation}</p>
            <ul className="space-y-1">
              {a.candidates.slice(0, 4).map((c) => (
                <li key={c.versionId} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={c.compatible ? "font-medium text-ink" : "text-muted line-through"}>{c.findingCode} · {c.score.toFixed(2)}</span>
                  <span className="text-muted">{c.compatible ? c.reasons.join("; ") : c.conflicts.join("; ")}</span>
                  {clinician && c.compatible && !o.negated && (
                    <Btn tone="ghost" disabled={busy || note.trim().length < 4} testId={`confirm-${c.findingCode}`} onClick={() => onResolve({ reportId: s(report, "id"), observationIndex: o.index, decision: "link_existing", targetVersionId: c.versionId, note })}>
                      {`Confirm ${c.findingCode}`}
                    </Btn>
                  )}
                </li>
              ))}
            </ul>
            {clinician && (
              <div className="flex flex-wrap gap-2">
                {!o.negated && <Btn tone="ghost" disabled={busy || note.trim().length < 4} onClick={() => onResolve({ reportId: s(report, "id"), observationIndex: o.index, decision: "create_provisional", note })}>Create provisional finding</Btn>}
                <Btn tone="ghost" disabled={busy || note.trim().length < 4} onClick={() => onResolve({ reportId: s(report, "id"), observationIndex: o.index, decision: "leave_unlinked", note })}>Leave unlinked</Btn>
              </div>
            )}
          </article>
        );
      })}
      {items.length === 0 && <p className="text-sm text-muted">No finding statements were extracted from this report.</p>}
    </section>
  );
}

/** Synthetic demo report text (for the Reports upload panel). */
export function demoReportFile(examKey: string): { name: string; bytes: Uint8Array } | null {
  const lines = DEMO_REPORTS[examKey as keyof typeof DEMO_REPORTS];
  return lines ? { name: `synthetic-${examKey}-report.txt`, bytes: new TextEncoder().encode(lines.join("\n")) } : null;
}

const CATEGORY: Record<string, string> = {
  likely_same: "Likely same finding",
  potentially_new: "Potentially new finding",
  possible_resolved: "Possible resolved",
  uncertain: "Uncertain correspondence",
  needs_review: "Needs clinician review",
  confirmed_match: "Confirmed match",
};
const ORIGIN: Record<string, { text: string; tone: "pine" | "clay" | "ink" }> = {
  live_recompute: { text: "Live computation", tone: "pine" },
  seeded_demo: { text: "Seeded demonstration (not a live analysis)", tone: "clay" },
  legacy_unlabelled: { text: "Origin not recorded (pre-run tracking)", tone: "ink" },
};

/** Requirement 2: ReproTrace review with live recompute, comparison panels and decision history. */
export function TraceReview({
  data,
  patient,
  clinician,
  busy,
  run,
  recompute,
  decide,
  seedDemo,
  registerDemo,
  onOpenVersion,
  review,
}: {
  data: Workspace;
  patient: Bag;
  clinician: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  recompute: (patientId: string) => Promise<unknown>;
  decide: (input: { correspondenceId: string; decision: "accept" | "reject" | "defer"; note: string }) => Promise<unknown>;
  seedDemo: () => Promise<unknown>;
  registerDemo: (patientId: string) => Promise<unknown>;
  onOpenVersion: (versionId: string) => void;
  review?: (input: { targetType: "discrepancy"; targetId: string; status: "verified" | "rejected" | "needs_more_information"; note: string }) => Promise<unknown>;
}) {
  const pid = s(patient, "id");
  const [note, setNote] = useState("");
  const rows = (data.correspondences as Bag[]).filter((c) => s(c, "patient_id") === pid);
  const decisions = data.decisions as Bag[];
  const versions = data.versions as unknown as Bag[];
  const findings = data.findings as Bag[];
  const studies = data.studies as Bag[];
  const discs = (data.discrepancies as Bag[]).filter((d) => s(d, "patient_id") === pid);
  const lastRun = (data.reprotraceRuns ?? []).find((r) => s(r, "patient_id") === pid);
  const runStudies: string[] = lastRun ? JSON.parse(s(lastRun, "study_ids_json") || "[]") : [];
  const runRegNotes: string[] = lastRun ? JSON.parse(s(lastRun, "registration_notes_json") || "[]") : [];

  const side = (vid: string) => {
    const v = versions.find((x) => s(x, "id") === vid);
    if (!v) return null;
    const f = findings.find((x) => s(x, "id") === s(v, "finding_id"));
    const st = studies.find((x) => s(x, "id") === s(v, "study_id"));
    const axes = (v as Bag).axes_mm as number[] | null;
    const evCount = (data.evidence as Bag[]).filter((e) => s(e, "finding_version_id") === vid).length;
    return { v, f, st, axes, evCount };
  };

  function Side({ title, vid }: { title: string; vid: string }) {
    const x = side(vid);
    if (!x) return <div className="rounded-md bg-paper p-2 text-sm text-muted"><p className="text-xs">{title}</p>No counterpart on this examination.</div>;
    return (
      <div className="space-y-1 rounded-md bg-paper p-2 text-sm">
        <p className="text-xs text-muted">{title}</p>
        <p className="text-ink">{s(x.st, "study_date")} · {s(x.v, "modality")}</p>
        <p>{s(x.f, "code")} v{s(x.v, "version_no")} · {s(x.f, "structure").replaceAll("_", " ")}</p>
        <p className="text-ink-soft">{s(x.v, "location_label")}</p>
        <p className="tabular-nums text-ink-soft">{Array.isArray(x.axes) ? `${x.axes.map((a) => Number(a).toFixed(0)).join(" × ")} mm` : `${s(x.v, "longest_mm") || "—"} mm longest`}{n(x.v, "volume_mm3") != null ? ` · ${Math.round(n(x.v, "volume_mm3")!)} mm³` : ""}</p>
        <p className="text-xs text-muted">Frame: {s(x.v, "frame").replaceAll("_", " ")} · {x.evCount} evidence link(s)</p>
        <Btn tone="ghost" onClick={() => onOpenVersion(vid)}>Open evidence</Btn>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <p className="text-sm font-medium text-pine">ReproTrace · {data.engineVersion}</p>
        <h1 className="text-3xl">Cross-examination correspondence</h1>
        <p className="max-w-3xl text-sm text-ink-soft">Proposals are never merges. Accepting records a relationship between two finding versions; both histories stay intact. Thresholds are unvalidated heuristics and synthetic tests are not evidence of clinical accuracy.</p>
        <div className="flex flex-wrap items-center gap-2">
          {clinician && <Btn testId="recompute-correspondence" disabled={busy} onClick={() => run(() => recompute(pid))}>Recompute correspondence</Btn>}
          {clinician && !isDemoPatient(pid) && <Btn tone="ghost" disabled={busy} onClick={() => run(seedDemo)}>Load synthetic ReproTrace demo patient</Btn>}
          {clinician && isDemoPatient(pid) && <Btn tone="ghost" disabled={busy} testId="register-demo" onClick={() => run(() => registerDemo(pid))}>Run rigid registration on demo series (moment-based prototype)</Btn>}
        </div>
        <div className="rounded-md border border-line bg-card p-3 text-xs text-ink-soft" data-testid="run-summary">
          {lastRun ? (
            <>
              <p><b>Last live computation:</b> {s(lastRun, "created_at")} · engine {s(lastRun, "engine_version")} · trigger {s(lastRun, "trigger").replaceAll("_", " ")}</p>
              <p>Examinations included: {runStudies.map((id) => s(studies.find((x) => s(x, "id") === id), "study_date") || id).join(", ") || "none"} · proposals {s(lastRun, "proposals_count")} · needing clinician review {s(lastRun, "review_required_count")}</p>
              <p>Spatial basis seen in this run: {runRegNotes.join(" · ") || "—"}</p>
            </>
          ) : (
            <p>No live computation has been recorded for this record. Any proposals shown below were seeded for the demonstration or created before run tracking.</p>
          )}
        </div>
      </header>
      {clinician && <input className="min-h-11 w-full max-w-2xl rounded-md border border-line bg-paper px-2 text-sm" placeholder="Optional decision note" value={note} onChange={(e) => setNote(e.target.value)} />}
      <div className="grid gap-3">
        {rows.map((row) => {
          const history = decisions.filter((d) => s(d, "correspondence_id") === s(row, "id"));
          const origin = ORIGIN[s(row, "origin")] ?? ORIGIN.legacy_unlabelled;
          const alts: string[] = s(row, "alternatives_json") ? JSON.parse(s(row, "alternatives_json")) : [];
          return (
            <article key={s(row, "id")} className="space-y-2 rounded-lg border border-line bg-card p-4" data-testid="correspondence">
              <div className="flex flex-wrap gap-2">
                <Chip tone="clay">{CATEGORY[s(row, "category")] ?? s(row, "category")}</Chip>
                {row.provisional === true && <Chip>Provisional</Chip>}
                <Chip tone={origin.tone}>{origin.text}</Chip>
                {s(row, "registration_status") && <Chip>{`Registration: ${s(row, "registration_status")}`}</Chip>}
                {alts.length > 0 && <Chip tone="clay">{`${alts.length} competing candidate(s)`}</Chip>}
              </div>
              <div className="grid gap-2 md:grid-cols-3">
                <Side title="Previous examination" vid={s(row, "from_version_id")} />
                <Side title="Current examination" vid={s(row, "to_version_id")} />
                <div className="space-y-1 rounded-md bg-paper p-2 text-sm">
                  <p className="text-xs text-muted">Correspondence result</p>
                  <p className="tabular-nums">Score {n(row, "score")?.toFixed(2) ?? "—"}{n(row, "uncertainty_mm") != null ? ` · ±${n(row, "uncertainty_mm")!.toFixed(1)} mm` : ""}</p>
                  <p className="tabular-nums">{n(row, "distance_mm") != null ? `Registered distance ${n(row, "distance_mm")!.toFixed(1)} mm` : "Spatial distance not valid / not computed"}</p>
                  {n(row, "registration_ncc") != null && <p className="text-xs text-muted">NCC {n(row, "registration_ncc")!.toFixed(2)} · residual {n(row, "registration_residual_mm")?.toFixed(1)} mm</p>}
                  {n(row, "volume_delta_pct") != null && <p className="text-xs text-muted">Volume change {n(row, "volume_delta_pct")!.toFixed(0)}% ({s(row, "attribution_category").replaceAll("_", " ")})</p>}
                </div>
              </div>
              <p className="text-sm text-ink-soft">{s(row, "rationale")}</p>
              {alts.length > 0 && <p className="text-xs text-clay">Competing: {alts.map((a) => { const x = side(a); return x ? `${s(x.f, "code")} v${s(x.v, "version_no")}` : a; }).join(", ")}</p>}
              {history.length > 0 && (
                <ul className="text-xs text-muted">
                  {history.map((d) => <li key={s(d, "id")}>{s(d, "created_at")} · {s(d, "decision")} by {s(d, "user_id")} · engine {s(d, "engine_version") || "?"} · “{s(d, "note")}”</li>)}
                </ul>
              )}
              {clinician && (
                <div className="flex flex-wrap gap-2">
                  <Btn disabled={busy} onClick={() => run(() => decide({ correspondenceId: s(row, "id"), decision: "accept", note: note || "Clinician agrees the observations correspond. Records were not merged." }))}>Accept as corresponding</Btn>
                  <Btn tone="ghost" disabled={busy} onClick={() => run(() => decide({ correspondenceId: s(row, "id"), decision: "reject", note: note || "Keep as separate observations." }))}>Keep separate</Btn>
                  <Btn tone="ghost" disabled={busy} onClick={() => run(() => decide({ correspondenceId: s(row, "id"), decision: "defer", note: note || "Deferred pending more information." }))}>Defer</Btn>
                </div>
              )}
            </article>
          );
        })}
        {rows.length === 0 && <p className="text-sm text-muted">No correspondence proposals yet. Use “Recompute correspondence”.</p>}
      </div>
      <h2 className="text-2xl">Discrepancies</h2>
      <div className="grid gap-3">
        {discs.map((d) => {
          const pairHist = (data.discrepancyReviewHistory ?? []).filter((r) => s(r, "left_ref") === s(d, "left_ref") && s(r, "right_ref") === s(d, "right_ref") && s(d, "left_ref") !== "");
          const history: Bag[] = pairHist.length ? (pairHist as Bag[]) : (data.reviews as unknown as Bag[]).filter((r) => s(r, "target_type") === "discrepancy" && s(r, "target_id") === s(d, "id"));
          const latest = [...history].reverse().find((r) => !s(r, "discrepancy_id") || s(r, "discrepancy_id") === s(d, "id"));
          return (
            <article key={s(d, "id")} className="space-y-2 rounded-lg border border-line bg-card p-4" data-testid="discrepancy-card">
              <div className="flex flex-wrap gap-2">
                <Chip tone="clay">{s(d, "category").replaceAll("_", " ")}</Chip>
                <Chip>Rule-based attribution · not clinically validated</Chip>
                {latest && <Chip tone="pine">{REVIEW_LABEL[s(latest, "status")] ?? s(latest, "status")}</Chip>}
              </div>
              <h3 className="text-lg">{s(d, "summary")}</h3>
              <p className="text-sm text-ink-soft">{s(d, "detail")}</p>
              <p className="text-xs text-muted">
                Compared: {s(d, "left_ref") || "source not recorded"} ↔ {s(d, "right_ref") || "source not recorded"} · {s(d, "engine_version")}
              </p>
              {history.length > 0 && (
                <ul className="text-xs text-ink-soft">
                  {history.map((r) => (
                    <li key={s(r, "id")}>{s(r, "created_at").slice(0, 16)} · {REVIEW_LABEL[s(r, "status")] ?? s(r, "status")} · {s(r, "note")}{s(r, "discrepancy_id") && s(r, "discrepancy_id") !== s(d, "id") ? ` (on an earlier computation: ${s(r, "category").replaceAll("_", " ")})` : ""}</li>
                  ))}
                </ul>
              )}
              {clinician && review && (
                <div className="flex flex-wrap gap-2">
                  {(["verified", "rejected", "needs_more_information"] as const).map((st) => (
                    <Btn
                      key={st}
                      tone={st === "verified" ? "pine" : "ghost"}
                      disabled={busy}
                      onClick={() => run(() => review({ targetType: "discrepancy", targetId: s(d, "id"), status: st, note: note.trim() || DEFAULT_REVIEW_NOTE[st] }))}
                    >
                      {REVIEW_ACTION[st]}
                    </Btn>
                  ))}
                </div>
              )}
            </article>
          );
        })}
        {clinician && discs.length > 0 && <p className="text-xs text-muted">The note field above is stored as the clinical annotation with each review. Original discrepancy rows are never edited.</p>}
        {discs.length === 0 && <p className="text-sm text-muted">No discrepancy rule fired for this record.</p>}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<TimelineSource, string> = {
  imaging_examination: "Imaging",
  report: "Report",
  finding_record: "Finding record",
  patient_reported: "Patient-reported",
  laboratory_record: "Lab record",
  clinician_decision: "Clinician decision",
};

/** Requirement 6: one dated list of examinations and context, each item with its source. */
export function PatientTimeline({ data, patientId }: { data: Workspace; patientId: string }) {
  const items = useMemo(() => buildPatientTimeline(data as unknown as TimelineWorkspace, patientId), [data, patientId]);
  const studyDate = (id: string) => s((data.studies as Bag[]).find((st) => s(st, "id") === id), "study_date").slice(0, 10);
  if (items.length === 0) return null;
  return (
    <article className="space-y-2 rounded-lg border border-line bg-card p-4" data-testid="patient-timeline">
      <h2 className="text-xl">Examination timeline with context</h2>
      <p className="text-xs text-muted">
        Items are placed by date only. Being close in time does not mean one caused the other. Patient-reported items are not clinician-confirmed.
      </p>
      <ol className="space-y-1 text-sm">
        {items.map((i) => (
          <li key={`${i.kind}-${i.refId}`} className={`flex flex-wrap gap-x-2 ${i.kind === "examination" ? "font-medium text-ink" : "text-ink-soft"}`}>
            <span className="tabular-nums text-muted">{i.date}</span>
            <Chip tone={i.source === "patient_reported" ? "clay" : i.source === "clinician_decision" ? "pine" : "ink"}>{SOURCE_LABEL[i.source]}</Chip>
            {i.synthetic && <Chip>Synthetic</Chip>}
            <span>{i.title}</span>
            {i.detail && <span className="text-xs text-muted">· {i.detail}</span>}
            {i.nearExaminations.length > 0 && (
              <span className="text-xs text-muted">· within {CONTEXT_WINDOW_DAYS} days of exam {i.nearExaminations.map(studyDate).join(", ")}</span>
            )}
          </li>
        ))}
      </ol>
    </article>
  );
}

const HISTORY_LABEL: Record<HistoryEvent["kind"], string> = {
  version: "Version",
  evidence: "Evidence",
  review: "Verification",
  correspondence: "Proposal",
  decision: "Decision",
  discrepancy: "Discrepancy",
  discrepancy_review: "Discrepancy review",
};

/** Requirement 5: full history of one finding (and findings a clinician accepted as the same). */
export function FindingHistory({ data, findingId }: { data: Workspace; findingId: string }) {
  const h = useMemo(() => buildFindingHistory(data as unknown as TimelineWorkspace, findingId), [data, findingId]);
  const code = (fid: string) => s((data.findings as Bag[]).find((f) => s(f, "id") === fid), "code");
  return (
    <article className="space-y-2 rounded-lg border border-line bg-card p-4" data-testid="finding-history">
      <h2 className="text-xl">Finding history</h2>
      {h.relatedFindingIds.length > 0 && (
        <p className="text-xs text-muted">
          Includes {h.relatedFindingIds.map(code).join(", ")}, linked by an accepted correspondence. Records stay separate; nothing was merged.
        </p>
      )}
      <ol className="space-y-1 text-sm">
        {h.events.map((e) => (
          <li key={`${e.kind}-${e.refId}`} className="text-ink-soft">
            <span className="tabular-nums text-muted">{e.at.slice(0, 16).replace("T", " ")}</span> · <span className="text-ink">{HISTORY_LABEL[e.kind]}</span>
            {e.findingId !== findingId && e.versionId ? ` (${code(e.findingId)})` : ""} · {e.title}
            {e.detail && <span className="block text-xs text-muted">{e.detail}</span>}
          </li>
        ))}
        {h.events.length === 0 && <li className="text-muted">No recorded history.</li>}
      </ol>
    </article>
  );
}

const SUMMARY_SECTIONS: { key: keyof Omit<EvidenceSummary, "versionId">; title: string; tone: "pine" | "clay" | "ink"; empty: string }[] = [
  { key: "clinicianVerified", title: "Clinician-verified", tone: "pine", empty: "Nothing verified by a clinician yet." },
  { key: "extractedStatements", title: "Extracted report statements (not yet verified)", tone: "ink", empty: "None." },
  { key: "algorithmSuggestions", title: "Algorithm suggestions (rule-based or classical; not confirmed)", tone: "clay", empty: "None." },
  { key: "unresolvedDiscrepancies", title: "Unresolved discrepancies", tone: "clay", empty: "None open." },
  { key: "patientReported", title: "Patient-reported and recorded context near this exam", tone: "ink", empty: "None recorded within 30 days." },
  { key: "missingEvidence", title: "Missing or unavailable evidence", tone: "clay", empty: "No gaps found." },
];

/** Requirement 7: what is known about this finding version, split by kind of source. */
export function EvidenceSummaryPanel({ data, versionId }: { data: Workspace; versionId: string }) {
  const sum = useMemo(() => buildEvidenceSummary(data as unknown as TimelineWorkspace, versionId), [data, versionId]);
  return (
    <article className="space-y-3 rounded-lg border border-line bg-card p-4" data-testid="evidence-summary">
      <h2 className="text-xl">What the record says, by source</h2>
      <p className="text-xs text-muted">Built only from stored records. It gives no diagnosis or treatment advice, and nearby context is not presented as a cause.</p>
      {SUMMARY_SECTIONS.map((sec) => (
        <section key={sec.key} className="space-y-1">
          <Chip tone={sec.tone}>{sec.title}</Chip>
          <ul className="list-disc pl-5 text-sm text-ink-soft">
            {sum[sec.key].map((i, n) => (
              <li key={`${i.ref ?? "x"}-${n}`}>
                {i.text} <span className="text-xs text-muted">({i.source})</span>
              </li>
            ))}
            {sum[sec.key].length === 0 && <li className="list-none text-xs text-muted">{sec.empty}</li>}
          </ul>
        </section>
      ))}
    </article>
  );
}
