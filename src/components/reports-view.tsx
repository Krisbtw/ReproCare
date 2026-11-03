import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ObservationLinker, demoReportFile, isDemoPatient } from "./reprotrace-panels";
import { extractReportText, kindFromName, type TextResult } from "@/lib/reports/text";
import { deidentify, type DeidResult } from "@/lib/reports/deidentify";
import {
  extractReport,
  longestMm,
  type Extraction,
  type Span,
  type ExtractionProvenance,
} from "@/lib/reports/extract";
import {
  buildDocx,
  buildPdf,
  buildMultiPagePdf,
  buildScannedPdf,
  SAMPLE_REPORT_LINES,
} from "@/lib/reports/fixtures";
import type { IngestInput, QuoteLinkInput } from "@/lib/reports/store";
import type {
  LlmInterpretationResult,
  ReportQuestionAnswerResult,
} from "@/lib/reports/llm-interpreter";
import type { Workspace } from "@/lib/clinic/types";

type Bag = Record<string, unknown>;

const s = (row: object | undefined, key: string): string => {
  if (!row) return "";
  const v = (row as Bag)[key];
  return v == null ? "" : String(v);
};

function Tag({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "pine" | "clay" }) {
  const cls =
    tone === "pine"
      ? "bg-pine-soft text-pine"
      : tone === "clay"
        ? "bg-clay-soft text-clay"
        : "bg-paper text-ink-soft";
  return (
    <span className={`inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

function ProvenanceBadge({ provenance }: { provenance?: ExtractionProvenance }) {
  const p = provenance ?? "explicitly_stated";
  const label =
    p === "clinician_confirmed"
      ? "clinician confirmed"
      : p === "explicitly_stated"
        ? "explicitly stated"
        : p === "parser_inferred"
          ? "parser inferred"
          : "AI generated (unreviewed)";
  const tone: "pine" | "clay" | "ink" =
    p === "clinician_confirmed" ? "pine" : p === "llm_generated" ? "clay" : "ink";
  return <Tag tone={tone}>{label}</Tag>;
}

function Btn({
  children,
  onClick,
  tone = "pine",
  disabled,
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "pine" | "ghost" | "clay";
  disabled?: boolean;
  testId?: string;
}) {
  const cls =
    tone === "ghost"
      ? "border border-line bg-card text-ink"
      : tone === "clay"
        ? "bg-clay text-card"
        : "bg-pine text-card";
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 rounded-md px-3 text-sm font-medium ${cls} disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
}

/** Highlights extracted spans in place. Offsets come from the extraction, so the marks are exactly the source text. */
function Highlighted({
  text,
  spans,
  onPick,
  picked,
}: {
  text: string;
  spans: (Span & { tone: "measure" | "figo" | "rec" })[];
  onPick?: (sp: Span) => void;
  picked?: Span | null;
}) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((sp, i) => {
    if (sp.start < cursor) return;
    if (sp.start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, sp.start)}</span>);
    const isPicked = picked && picked.start === sp.start && picked.end === sp.end;
    const cls =
      sp.tone === "figo"
        ? "bg-pine-soft text-pine"
        : sp.tone === "rec"
          ? "bg-paper text-ink underline decoration-dotted"
          : "bg-clay-soft text-clay";
    parts.push(
      <button
        key={`m${i}`}
        type="button"
        onClick={() => onPick?.(sp)}
        className={`rounded-sm px-0.5 ${cls} ${isPicked ? "ring-2 ring-pine" : ""}`}
        title={onPick ? "Use this exact text as a quote" : undefined}
      >
        {text.slice(sp.start, sp.end)}
      </button>,
    );
    cursor = sp.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-paper p-3 font-sans text-sm leading-6 text-ink">
      {parts}
    </pre>
  );
}

function spansOf(x: Extraction) {
  return [
    ...x.measurements.map((m) => ({
      start: m.start,
      end: m.end,
      text: m.text,
      tone: "measure" as const,
    })),
    ...x.figo.map((f) => ({ ...f, tone: "figo" as const })),
  ];
}

function ExtractionSummary({
  x,
  clinician,
  onDecideFinding,
  busy,
}: {
  x: Extraction;
  clinician?: boolean;
  onDecideFinding?: (
    findingIndex: number,
    decision: "approved" | "rejected",
    note: string,
  ) => void;
  busy?: boolean;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-1 rounded-md bg-paper p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">Examination & Metadata</p>
          <Tag tone={x.reviewStatus === "reviewed" || x.reviewStatus === "corrected" ? "pine" : "ink"}>
            {x.reviewStatus ? `review: ${x.reviewStatus}` : "unreviewed extraction"}
          </Tag>
        </div>
        <p>
          Modality: <b>{x.modality ?? "not stated"}</b>{" "}
          <ProvenanceBadge provenance={x.modalityProvenance ?? undefined} /> · Date:{" "}
          <b>{x.examDate ?? "not found"}</b>{" "}
          <ProvenanceBadge provenance={x.examDateProvenance ?? undefined} />
        </p>
        <p className="text-xs text-muted">
          Region: {x.anatomicalRegion ?? "pelvis"} · Method: {x.extractionMethod ?? "plain_text"} · Pages:{" "}
          {x.pageCount ?? 1}
        </p>
        {x.reportAuthorOrInstitution && (
          <p className="text-xs text-muted">
            Institution/Author role: {x.reportAuthorOrInstitution.roleOrDepartment ?? x.reportAuthorOrInstitution.note}
          </p>
        )}
        <p className="text-xs text-muted">Extractor {x.extractor} (deterministic rules)</p>
      </div>
      <div className="space-y-1 rounded-md bg-paper p-3 text-sm">
        <p className="text-xs text-muted">Measurements written in the report</p>
        {x.measurements.length === 0 && <p className="text-muted">None found.</p>}
        <ul className="space-y-1">
          {x.measurements.map((m, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">{m.text}</span>
              <span className="text-muted">
                · {m.structure ?? "structure not named in sentence"}
                {m.anatomicalLocation ? ` (${m.anatomicalLocation})` : ""}
                {m.laterality ? ` · ${m.laterality}` : ""}
                {longestMm(m) != null ? ` · longest ${longestMm(m)!.toFixed(0)} mm` : ""}
                {m.pageNumber ? ` · p.${m.pageNumber}` : ""}
              </span>
              <ProvenanceBadge provenance={m.provenance} />
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2 rounded-md bg-paper p-3 text-sm md:col-span-2">
        <p className="text-xs text-muted">
          Structured finding sentences (provenance & clinician review status)
        </p>
        {x.findings.length === 0 && <p className="text-muted">No finding terms were recognised.</p>}
        <ul className="space-y-2">
          {x.findings.map((f, i) => (
            <li
              key={i}
              className="flex flex-wrap items-center gap-2 rounded-sm border border-line bg-card p-2"
            >
              <Tag tone={f.negated ? "ink" : f.uncertain ? "clay" : "pine"}>
                {f.negated
                  ? `negated · ${f.structure}`
                  : f.uncertain
                    ? `uncertain · ${f.structure}`
                    : f.structure}
              </Tag>
              {f.anatomicalLocation && <Tag>{f.anatomicalLocation}</Tag>}
              {f.figo && <Tag tone="pine">{`FIGO ${f.figo} (as written)`}</Tag>}
              {f.pageNumber && <Tag>{`p.${f.pageNumber}`}</Tag>}
              <ProvenanceBadge provenance={f.provenance} />
              {f.reviewStatus && f.reviewStatus !== "unreviewed" && (
                <Tag tone={f.reviewStatus === "approved" || f.reviewStatus === "edited" ? "pine" : "clay"}>
                  {`clinician ${f.reviewStatus}`}
                </Tag>
              )}
              <span className="text-ink-soft">“{f.sentence.text}”</span>
              {clinician && onDecideFinding && (
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      onDecideFinding(
                        i,
                        "approved",
                        "Clinician verified extracted finding against source report.",
                      )
                    }
                    className="rounded border border-pine px-2 py-0.5 text-xs text-pine hover:bg-pine-soft"
                  >
                    Approve finding
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      onDecideFinding(
                        i,
                        "rejected",
                        "Clinician rejected extracted finding.",
                      )
                    }
                    className="rounded border border-clay px-2 py-0.5 text-xs text-clay hover:bg-clay-soft"
                  >
                    Reject
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {x.impressions && x.impressions.length > 0 && (
        <div className="space-y-1 rounded-md bg-paper p-3 text-sm md:col-span-2">
          <p className="text-xs text-muted">Impression / Conclusion (verbatim from report)</p>
          {x.impressions.map((imp, i) => (
            <p key={i} className="text-ink-soft">
              “{imp.text}” {imp.pageNumber ? <span className="text-xs text-muted">(p.{imp.pageNumber})</span> : null}
            </p>
          ))}
        </div>
      )}
      {x.recommendations.length > 0 && (
        <div className="space-y-1 rounded-md bg-paper p-3 text-sm md:col-span-2">
          <p className="text-xs text-muted">
            Recommendations written by the report author (quoted, not generated)
          </p>
          {x.recommendations.map((r, i) => (
            <p key={i} className="text-ink-soft">
              “{r.text}”
            </p>
          ))}
        </div>
      )}
      {x.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted md:col-span-2">
          {x.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Draft = {
  fileName: string;
  kind: TextResult["kind"];
  sha256: string;
  rawBytesBase64: string;
  raw: TextResult;
  deid: DeidResult;
  extraction: Extraction;
};

export function ReportsView({
  data,
  patient,
  clinician,
  busy,
  run,
  upload,
  link,
  onReviewExtraction,
  onDecideFinding,
  onInterpretReport,
  onAskReportQuestion,
  onResolveObservation,
  focus,
}: {
  onResolveObservation?: (input: {
    reportId: string;
    observationIndex: number;
    decision: "link_existing" | "create_provisional" | "leave_unlinked";
    targetVersionId?: string | null;
    note: string;
  }) => Promise<unknown>;
  focus?: { reportId: string; start: number | null; end: number | null; nonce: number } | null;
  data: Workspace;
  patient: Bag;
  clinician: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  upload: (input: IngestInput) => Promise<unknown>;
  link: (input: QuoteLinkInput) => Promise<unknown>;
  onReviewExtraction?: (input: {
    reportId: string;
    ocrReviewed?: boolean;
    editedModality?: string | null;
    editedExamDate?: string | null;
    reviewStatus: "reviewed" | "corrected" | "rejected";
    reason: string;
  }) => Promise<unknown>;
  onDecideFinding?: (input: {
    reportId: string;
    findingIndex: number;
    decision: "approved" | "rejected" | "edited";
    note: string;
  }) => Promise<unknown>;
  onInterpretReport?: (reportId: string) => Promise<LlmInterpretationResult>;
  onAskReportQuestion?: (
    reportId: string,
    question: string,
  ) => Promise<ReportQuestionAnswerResult>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [target, setTarget] = useState<string>("new");
  const [newModality, setNewModality] = useState("MR");
  const [newDate, setNewDate] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<string>("");
  const [picked, setPicked] = useState<Span | null>(null);
  const [linkVersion, setLinkVersion] = useState("");
  const [linkNote, setLinkNote] = useState("");

  // Clinician review & LLM interpretation state
  const [editModality, setEditModality] = useState("");
  const [editExamDate, setEditExamDate] = useState("");
  const [reviewReason, setReviewReason] = useState("Verified extracted fields and OCR output against original document.");
  const [interpretation, setInterpretation] = useState<LlmInterpretationResult | null>(null);
  const [questionText, setQuestionText] = useState("");
  const [qaResult, setQaResult] = useState<ReportQuestionAnswerResult | null>(null);

  const pid = s(patient, "id");
  const studies = (data.studies as Bag[]).filter((st) => s(st, "patient_id") === pid);
  const studyIds = new Set(studies.map((st) => s(st, "id")));
  const reports = (data.reports as Bag[]).filter((r) => studyIds.has(s(r, "study_id")));
  const extractionByReport = useMemo(
    () => new Map((data.extractions ?? []).map((e) => [e.report_id, e])),
    [data.extractions],
  );
  const findings = (data.findings as Bag[]).filter((f) => s(f, "patient_id") === pid);
  const findingIds = new Set(findings.map((f) => s(f, "id")));
  const latestVersions = useMemo(() => {
    const byFinding = new Map<string, Bag>();
    for (const v of data.versions as unknown as Bag[]) {
      if (!findingIds.has(s(v, "finding_id"))) continue;
      const cur = byFinding.get(s(v, "finding_id"));
      if (!cur || Number(v.version_no) > Number(cur.version_no))
        byFinding.set(s(v, "finding_id"), v);
    }
    return [...byFinding.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.versions, pid, data.findings]);

  async function readFile(name: string, bytes: Uint8Array) {
    setError(null);
    setSaved(null);
    setConfirmed(false);
    setDraft(null);
    setReading(true);
    try {
      const kind = kindFromName(name);
      if (!kind) throw new Error("Only .txt, .docx and .pdf reports are accepted.");
      const raw = await extractReportText(name, bytes);
      const deid = deidentify(raw.text);
      const extraction = extractReport(deid.text, {
        rawTextForMetadata: raw.text,
        extractionMethod: raw.extractionMethod,
        pageCount: raw.pageCount,
        pages: raw.pages,
      });
      const sha256 = await sha256Hex(bytes);
      const rawBytesBase64 = bytesToBase64(bytes);
      setDraft({ fileName: name, kind, sha256, rawBytesBase64, raw, deid, extraction });
      if (extraction.examDate) setNewDate(extraction.examDate);
      if (extraction.modality) setNewModality(extraction.modality);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be read.");
    } finally {
      setReading(false);
    }
  }

  async function onFile(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    await readFile(f.name, new Uint8Array(await f.arrayBuffer()));
    if (fileInput.current) fileInput.current.value = "";
  }

  async function sample(kind: "pdf" | "scanned_pdf" | "multipage_pdf" | "docx" | "txt") {
    if (kind === "scanned_pdf") {
      const bytes = await buildScannedPdf([SAMPLE_REPORT_LINES]);
      await readFile("synthetic-scanned-report.pdf", bytes);
      return;
    }
    if (kind === "multipage_pdf") {
      const bytes = await buildMultiPagePdf([
        { lines: SAMPLE_REPORT_LINES.slice(0, 5), mode: "native" },
        { lines: SAMPLE_REPORT_LINES.slice(5), mode: "scanned" },
      ]);
      await readFile("synthetic-hybrid-multipage-report.pdf", bytes);
      return;
    }
    const bytes =
      kind === "pdf"
        ? await buildPdf(SAMPLE_REPORT_LINES)
        : kind === "docx"
          ? await buildDocx(SAMPLE_REPORT_LINES)
          : new TextEncoder().encode(SAMPLE_REPORT_LINES.join("\n"));
    await readFile(`synthetic-follow-up-report.${kind}`, bytes);
  }

  function save() {
    if (!draft || !confirmed) return;
    const input: IngestInput = {
      patientId: pid,
      studyId: target === "new" ? null : target,
      newStudy:
        target === "new"
          ? {
              modality: newModality,
              date: newDate,
              description: `Report upload: ${draft.fileName}`.slice(0, 160),
            }
          : null,
      fileName: draft.fileName,
      fileKind: draft.kind,
      sha256: draft.sha256,
      text: draft.deid.text,
      warnings: draft.raw.warnings,
      rawBytesBase64: draft.rawBytesBase64,
      extractionMethod: draft.raw.extractionMethod,
      pageCount: draft.raw.pageCount,
      pages: draft.raw.pages,
      ocrUsed: draft.raw.ocrUsed,
    };
    void run(async () => {
      await upload(input);
      setSaved(
        "Saved. The original document and de-identified extraction are stored with SHA-256 provenance and reconciled against imaging findings.",
      );
      setDraft(null);
      setConfirmed(false);
    });
  }

  // Navigation from an evidence trail: open the report and highlight the exact quote.
  useEffect(() => {
    if (!focus) return;
    setOpenReport(focus.reportId);
    if (focus.start != null && focus.end != null) {
      const r = reports.find((x) => s(x, "id") === focus.reportId);
      const body = s(r, "body");
      setPicked({ start: focus.start, end: focus.end, text: body.slice(focus.start, focus.end) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const shownReport = reports.find((r) => s(r, "id") === openReport) ?? null;
  const shownExtractionRow = shownReport ? extractionByReport.get(s(shownReport, "id")) : undefined;
  const shownExtraction: Extraction | null = useMemo(() => {
    if (!shownReport) return null;
    try {
      return shownExtractionRow
        ? (JSON.parse(shownExtractionRow.extraction) as Extraction)
        : extractReport(s(shownReport, "body"));
    } catch {
      return null;
    }
  }, [shownReport, shownExtractionRow]);

  function doLink() {
    if (!shownReport || !picked || !linkVersion) return;
    void run(async () => {
      await link({
        findingVersionId: linkVersion,
        reportId: s(shownReport, "id"),
        start: picked.start,
        end: picked.end,
        quote: picked.text,
        note: linkNote,
      });
      setPicked(null);
      setLinkNote("");
      setSaved(
        "Quote linked as evidence. The finding version itself was not changed; the link appears in the Studio evidence list.",
      );
    });
  }

  const evidenceForReport = (reportId: string) =>
    (data.evidence as Bag[]).filter(
      (e) => s(e, "report_id") === reportId && s(e, "kind") === "report_quote",
    );

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-medium text-pine">Clinical reports</p>
        <h1 className="text-3xl text-ink">
          Report intake, page-aware OCR, and source-anchored clinical intelligence
        </h1>
        <p className="max-w-3xl text-ink-soft">
          Ingest TXT, DOCX, native PDF, or scanned PDF reports, apply page-selective OCR where
          needed, de-identify personal identifiers, extract structured measurements with 4-tier
          provenance, and reconcile report measurements with imaging-derived findings.
        </p>
        <div className="flex flex-wrap gap-2">
          <Tag tone="pine">4-tier provenance: explicitly stated · parser inferred · AI generated · clinician confirmed</Tag>
          <Tag tone="clay">OCR & AI explanations are never treated as verified without clinician review</Tag>
          <Tag>Persistent SHA-256 original document storage</Tag>
        </div>
      </header>

      {error && <p className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">{error}</p>}
      {saved && <p className="rounded-md bg-pine-soft px-3 py-2 text-sm text-pine">{saved}</p>}

      {clinician ? (
        <section className="space-y-3 rounded-lg border border-line bg-card p-4">
          <h2 className="text-xl">1. Read a report (Native PDF, Scanned PDF OCR, DOCX, TXT)</h2>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => void onFile(e.target.files)}
            />
            <Btn
              tone="ghost"
              disabled={reading || busy}
              onClick={() => fileInput.current?.click()}
              testId="report-choose"
            >
              Choose a report file
            </Btn>
            <Btn
              tone="ghost"
              disabled={reading || busy}
              onClick={() => void sample("pdf")}
              testId="report-sample-pdf"
            >
              Sample · Native PDF
            </Btn>
            <Btn
              tone="ghost"
              disabled={reading || busy}
              onClick={() => void sample("scanned_pdf")}
              testId="report-sample-scanned-pdf"
            >
              Sample · Scanned PDF (built-in synthetic-font OCR)
            </Btn>
            <Btn
              tone="ghost"
              disabled={reading || busy}
              onClick={() => void sample("multipage_pdf")}
              testId="report-sample-multipage-pdf"
            >
              Sample · Multi-page Hybrid PDF
            </Btn>
            <Btn tone="ghost" disabled={reading || busy} onClick={() => void sample("docx")}>
              Sample · DOCX
            </Btn>
            <Btn tone="ghost" disabled={reading || busy} onClick={() => void sample("txt")}>
              Sample · TXT
            </Btn>
            {isDemoPatient(pid) &&
              (["rtdemo-ex1", "rtdemo-ex2"] as const).map((key, i) => (
                <Btn
                  key={key}
                  tone="ghost"
                  disabled={reading || busy}
                  testId={`demo-report-${i + 1}`}
                  onClick={() => {
                    const file = demoReportFile(key);
                    const study = studies.find((st) => s(st, "id").endsWith(`:${key}`));
                    if (!file) return;
                    void readFile(file.name, file.bytes).then(() => {
                      if (study) setTarget(s(study, "id"));
                    });
                  }}
                >
                  {`Synthetic demo report · exam ${i + 1}`}
                </Btn>
              ))}
          </div>
          <p className="text-xs text-muted">
            Limits: 15 MB. Native PDF pages are read directly; scanned PDF pages invoke page-aware
            OCR and record per-page provenance without claiming unverified OCR accuracy.
          </p>
          {reading && <p className="text-sm text-muted">Reading the file…</p>}

          {draft && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Tag>{draft.fileName}</Tag>
                <Tag>{draft.kind.toUpperCase()}</Tag>
                <Tag tone="pine">{`method: ${draft.raw.extractionMethod}`}</Tag>
                <Tag>{`${draft.raw.pageCount} page(s)`}</Tag>
                <Tag>{`sha256 ${draft.sha256.slice(0, 12)}…`}</Tag>
                <Tag tone={draft.raw.usable ? "pine" : "clay"}>
                  {draft.raw.usable ? "readable text recovered" : "little readable text"}
                </Tag>
                <Tag tone={draft.deid.redactions.length ? "pine" : "ink"}>
                  {`${draft.deid.redactions.length} redaction${draft.deid.redactions.length === 1 ? "" : "s"}`}
                </Tag>
              </div>
              {draft.raw.ocrUsed && (
                <div
                  className="rounded-md border border-clay bg-clay-soft p-3 text-sm text-clay"
                  role="alert"
                >
                  <p className="font-semibold">
                    OCR Used on Scanned Page(s) — Clinician Review Required
                  </p>
                  <p className="mt-1 text-xs">
                    Extraction method: <b>{draft.raw.extractionMethod}</b>. OCR accuracy is not
                    claimed without validation (`ocrAccuracyClaimed: false`). Please verify all
                    numbers and clinical terms against the original document before approving
                    findings.
                  </p>
                </div>
              )}
              {draft.raw.warnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
                  {draft.raw.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <div>
                <h3 className="text-lg">2. Check the de-identified text</h3>
                <p className="text-xs text-muted">
                  This exact text is what will be stored in the report body. Removed values show as
                  [KIND REMOVED]. Highlights: clay = measurement, green = FIGO as written.
                </p>
                <Highlighted text={draft.deid.text} spans={spansOf(draft.extraction)} />
                <p className="mt-1 text-xs text-muted">
                  Removed kinds:{" "}
                  {[...new Set(draft.deid.redactions.map((r) => r.kind))].join(", ") || "none"}.
                  Only kind and length of each removal are kept.
                </p>
              </div>
              <ExtractionSummary x={draft.extraction} />
              <div className="space-y-3 rounded-md border border-line p-3">
                <h3 className="text-lg">3. Attach and save</h3>
                <label className="block text-sm">
                  Attach to
                  <select
                    className="ml-2 min-h-11 rounded-md border border-line bg-paper px-2 text-sm"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="new">A new study entry</option>
                    {studies.map((st) => (
                      <option key={s(st, "id")} value={s(st, "id")}>
                        {`${s(st, "study_date").slice(0, 10)} · ${s(st, "modality")} · ${s(st, "description")}`.slice(
                          0,
                          90,
                        )}
                      </option>
                    ))}
                  </select>
                </label>
                {target === "new" && (
                  <div className="flex flex-wrap gap-3 text-sm">
                    <label>
                      Modality
                      <select
                        className="ml-2 min-h-11 rounded-md border border-line bg-paper px-2"
                        value={newModality}
                        onChange={(e) => setNewModality(e.target.value)}
                      >
                        <option value="MR">MR</option>
                        <option value="US">US</option>
                        <option value="CT">CT</option>
                        <option value="OT">Other</option>
                      </select>
                    </label>
                    <label>
                      Study date
                      <input
                        type="date"
                        className="ml-2 min-h-11 rounded-md border border-line bg-paper px-2"
                        value={newDate}
                        onChange={(e) => setNewDate(e.target.value)}
                      />
                    </label>
                    {!draft.extraction.examDate && (
                      <span className="self-center text-xs text-clay">
                        No date was found in the text; enter it from the report.
                      </span>
                    )}
                  </div>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    data-testid="report-confirm"
                  />
                  <span>
                    I have read the de-identified text above and no names, numbers or contact
                    details that identify a person remain. (The server repeats the same
                    de-identification before storing.)
                  </span>
                </label>
                <Btn
                  disabled={
                    !confirmed || busy || !draft.raw.usable || (target === "new" && !newDate)
                  }
                  onClick={save}
                  testId="report-save"
                >
                  Save de-identified report
                </Btn>
              </div>
            </div>
          )}
        </section>
      ) : (
        <p className="rounded-lg border border-line bg-card p-4 text-ink-soft">
          Report upload, extraction editing, and evidence linking are clinician actions. The reports
          on your record are listed below, with clinician-reviewed information clearly distinguished
          from unreviewed AI explanations.
        </p>
      )}

      <section className="space-y-3 rounded-lg border border-line bg-card p-4">
        <h2 className="text-xl">Reports on this record</h2>
        {reports.length === 0 && (
          <p className="text-muted">No reports are stored for this record yet.</p>
        )}
        <ul className="divide-y divide-line">
          {reports.map((r) => {
            const ex = extractionByReport.get(s(r, "id"));
            const st = studies.find((x) => s(x, "id") === s(r, "study_id"));
            const revStatus = ex?.review_status || s(r, "review_status") || "unreviewed";
            return (
              <li key={s(r, "id")} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="tabular-nums">{s(r, "report_date").slice(0, 10)}</span>
                <span className="text-muted">
                  {st ? `${s(st, "modality")} · ${s(st, "description")}` : ""}
                </span>
                <Tag tone={s(r, "source_kind") === "uploaded" ? "pine" : "ink"}>
                  {s(r, "source_kind") === "uploaded"
                    ? `uploaded ${ex?.file_kind?.toUpperCase() ?? ""}`
                    : "synthetic seed"}
                </Tag>
                {ex?.extraction_method && <Tag>{ex.extraction_method}</Tag>}
                <Tag tone={revStatus === "reviewed" || revStatus === "corrected" ? "pine" : "clay"}>
                  {revStatus === "reviewed" || revStatus === "corrected"
                    ? `clinician ${revStatus}`
                    : "unreviewed"}
                </Tag>
                {evidenceForReport(s(r, "id")).length > 0 && (
                  <Tag>{`${evidenceForReport(s(r, "id")).length} linked quote(s)`}</Tag>
                )}
                <span className="ml-auto" />
                <Btn
                  tone="ghost"
                  onClick={() => {
                    const nextId = openReport === s(r, "id") ? "" : s(r, "id");
                    setOpenReport(nextId);
                    setPicked(null);
                    setInterpretation(null);
                    setQaResult(null);
                  }}
                >
                  {openReport === s(r, "id") ? "Close" : "Open"}
                </Btn>
              </li>
            );
          })}
        </ul>

        {shownReport && shownExtraction && (
          <div className="space-y-4 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">
                {clinician
                  ? "Click a highlighted measurement or FIGO phrase to use that exact text as a quote, or review/approve extracted fields below."
                  : "Highlighted text was extracted from your report. Clinician-confirmed items are badged in green; unreviewed AI explanations are badged in clay."}
                {shownExtractionRow &&
                  ` Stored extraction by ${shownExtractionRow.extractor} (v${shownExtractionRow.version_no ?? 1}); de-identified by ${shownExtractionRow.deid_method}.`}
              </p>
              {shownExtractionRow?.report_object_id && (
                <Tag tone="pine">{`Original document persisted: ${shownExtractionRow.report_object_id.slice(0, 8)}…`}</Tag>
              )}
            </div>
            <Highlighted
              text={s(shownReport, "body")}
              spans={[
                ...spansOf(shownExtraction).filter(
                  (sp) => !picked || sp.end <= picked.start || sp.start >= picked.end,
                ),
                ...(picked && !spansOf(shownExtraction).some((sp) => sp.start === picked.start && sp.end === picked.end)
                  ? [{ ...picked, tone: "rec" as const }]
                  : []),
              ]}
              picked={picked}
              onPick={clinician ? setPicked : undefined}
            />
            <ExtractionSummary
              x={shownExtraction}
              clinician={clinician}
              busy={busy}
              onDecideFinding={
                clinician && onDecideFinding
                  ? (findingIndex, decision, note) => {
                      void run(async () => {
                        await onDecideFinding({
                          reportId: s(shownReport, "id"),
                          findingIndex,
                          decision,
                          note,
                        });
                        setSaved(`Finding #${findingIndex + 1} marked as ${decision}.`);
                      });
                    }
                  : undefined
              }
            />

            <ObservationLinker
              data={data}
              patientId={pid}
              report={shownReport}
              extraction={shownExtraction}
              clinician={clinician && Boolean(onResolveObservation)}
              busy={busy}
              onFocusQuote={(start, end) =>
                setPicked({ start, end, text: s(shownReport, "body").slice(start, end) })
              }
              onResolve={(input) => {
                if (!onResolveObservation) return;
                void run(async () => {
                  await onResolveObservation(input);
                  setSaved(
                    `Observation #${input.observationIndex + 1}: ${input.decision.replaceAll("_", " ")}. Decision, candidate state and source offsets were recorded; findings were not merged.`,
                  );
                });
              }}
            />

            {/* Clinician Review & Field Correction Panel (Task 2F) */}
            {clinician && onReviewExtraction && (
              <div className="space-y-2 rounded-md border border-line bg-paper p-3">
                <h3 className="text-base font-medium">
                  Clinician Review & Extraction Correction (Preserves Revision History)
                </h3>
                <div className="grid gap-2 sm:grid-cols-3 text-sm">
                  <label className="block text-xs text-muted">
                    Override Modality (optional)
                    <input
                      className="mt-1 min-h-10 w-full rounded-md border border-line bg-card px-2 text-sm text-ink"
                      placeholder={shownExtraction.modality ?? "MR / US"}
                      value={editModality}
                      onChange={(e) => setEditModality(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs text-muted">
                    Override Exam Date (optional)
                    <input
                      type="date"
                      className="mt-1 min-h-10 w-full rounded-md border border-line bg-card px-2 text-sm text-ink"
                      value={editExamDate}
                      onChange={(e) => setEditExamDate(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs text-muted">
                    Review / Correction Note
                    <input
                      className="mt-1 min-h-10 w-full rounded-md border border-line bg-card px-2 text-sm text-ink"
                      value={reviewReason}
                      onChange={(e) => setReviewReason(e.target.value)}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn
                    disabled={busy || reviewReason.trim().length < 4}
                    onClick={() => {
                      void run(async () => {
                        await onReviewExtraction({
                          reportId: s(shownReport, "id"),
                          ocrReviewed: true,
                          editedModality: editModality.trim() ? editModality.trim() : undefined,
                          editedExamDate: editExamDate.trim() ? editExamDate.trim() : undefined,
                          reviewStatus:
                            editModality.trim() || editExamDate.trim() ? "corrected" : "reviewed",
                          reason: reviewReason.trim(),
                        });
                        setEditModality("");
                        setEditExamDate("");
                        setSaved("Report extraction reviewed and revision saved to history.");
                      });
                    }}
                  >
                    Confirm & Mark Report Extraction Reviewed
                  </Btn>
                </div>
              </div>
            )}

            {/* Source-Grounded AI Interpretation & Report Q&A Panel (Task 2D & 2F) */}
            <div className="space-y-3 rounded-md border border-line bg-paper p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-medium">
                    Source-Grounded AI Report Summary & Q&A
                  </h3>
                  <p className="text-xs text-muted">
                    Every statement is anchored to exact page and character offsets in this report.
                    Unreviewed AI explanations are not a diagnosis or treatment plan.
                  </p>
                </div>
                <Tag tone="clay">Unreviewed AI Explanation · Not a Clinical Diagnosis</Tag>
              </div>
              {onInterpretReport && (
                <div className="flex flex-wrap gap-2">
                  <Btn
                    tone="ghost"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        const res = await onInterpretReport(s(shownReport, "id"));
                        setInterpretation(res);
                      });
                    }}
                    testId="report-ai-interpret"
                  >
                    Generate Source-Grounded Summary
                  </Btn>
                </div>
              )}
              {interpretation && (
                <div className="space-y-2 rounded-md border border-line bg-card p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag tone="clay">AI-Generated Summary (Unreviewed)</Tag>
                    <Tag>{`provider: ${interpretation.provider}`}</Tag>
                    <Tag>{`claims: ${interpretation.claims.length}`}</Tag>
                  </div>
                  <p className="text-ink">{interpretation.generatedExplanationSummary}</p>
                  {interpretation.uncertaintyFlags.length > 0 && (
                    <div className="rounded bg-clay-soft p-2 text-xs text-clay">
                      <b>Uncertainty flags:</b> {interpretation.uncertaintyFlags.join(" · ")}
                    </div>
                  )}
                  <ul className="space-y-1 text-xs text-ink-soft">
                    {interpretation.claims.map((c, idx) => (
                      <li key={idx}>
                        • {c.statement}{" "}
                        <span className="text-muted">
                          [p.{c.citation.pageNumber}, chars {c.citation.startOffset}–
                          {c.citation.endOffset}: “{c.citation.verbatimQuote}”]
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted">{interpretation.disclaimer}</p>
                </div>
              )}
              {onAskReportQuestion && (
                <div className="space-y-2 pt-2 border-t border-line">
                  <div className="flex flex-wrap gap-2">
                    <input
                      className="min-h-10 flex-1 rounded-md border border-line bg-card px-2 text-sm text-ink"
                      placeholder="Ask a question grounded in this report (e.g., What fibroid measurements were reported?)"
                      value={questionText}
                      onChange={(e) => setQuestionText(e.target.value)}
                    />
                    <Btn
                      tone="ghost"
                      disabled={busy || !questionText.trim()}
                      onClick={() => {
                        void run(async () => {
                          const res = await onAskReportQuestion(
                            s(shownReport, "id"),
                            questionText.trim(),
                          );
                          setQaResult(res);
                        });
                      }}
                    >
                      Ask Report
                    </Btn>
                  </div>
                  {qaResult && (
                    <div className="rounded-md border border-line bg-card p-3 text-sm space-y-1">
                      <div className="flex items-center gap-2">
                        <Tag tone={qaResult.status === "answered" ? "pine" : "clay"}>
                          {qaResult.status === "answered"
                            ? "Source-Grounded Answer"
                            : "Insufficient Evidence in Report"}
                        </Tag>
                        <Tag tone="clay">Unreviewed AI Output</Tag>
                      </div>
                      <p className="text-ink">{qaResult.answer}</p>
                      {qaResult.citations.map((cit, idx) => (
                        <p key={idx} className="text-xs text-muted">
                          Citation [p.{cit.pageNumber}, {cit.startOffset}–{cit.endOffset}]: “
                          {cit.verbatimQuote}”
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {clinician && (
              <div className="space-y-2 rounded-md border border-line p-3">
                <h3 className="text-lg">Link a quote to a finding version</h3>
                <p className="text-sm">
                  Quote:{" "}
                  {picked ? (
                    <b>“{picked.text}”</b>
                  ) : (
                    <span className="text-muted">none selected</span>
                  )}
                  {picked && (
                    <span className="text-xs text-muted">
                      {" "}
                      · characters {picked.start}–{picked.end}
                    </span>
                  )}
                </p>
                <label className="block text-sm">
                  Finding (latest version)
                  <select
                    className="ml-2 min-h-11 rounded-md border border-line bg-paper px-2 text-sm"
                    value={linkVersion}
                    onChange={(e) => setLinkVersion(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {latestVersions.map((v) => {
                      const f = findings.find((x) => s(x, "id") === s(v, "finding_id"));
                      return (
                        <option key={s(v, "id")} value={s(v, "id")}>
                          {`${s(f, "code")} · ${s(f, "structure")} · v${s(v, "version_no")} · ${s(v, "location_label")}`.slice(
                            0,
                            90,
                          )}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <input
                  className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm"
                  placeholder="Optional note (why this quote supports this finding)"
                  value={linkNote}
                  onChange={(e) => setLinkNote(e.target.value)}
                />
                <Btn
                  disabled={!picked || !linkVersion || busy}
                  onClick={doLink}
                  testId="report-link"
                >
                  Link quote as evidence
                </Btn>
                <p className="text-xs text-muted">
                  The server checks that the quote is exactly the stored text at those positions and
                  that the report and finding belong to the same record. Linking adds evidence; it
                  does not change measurements or create a new version.
                </p>
              </div>
            )}
            {evidenceForReport(s(shownReport, "id")).length > 0 && (
              <div className="space-y-1 text-sm">
                <p className="text-xs text-muted">Quotes already linked from this report</p>
                {evidenceForReport(s(shownReport, "id")).map((e) => {
                  const v = (data.versions as unknown as Bag[]).find(
                    (x) => s(x, "id") === s(e, "finding_version_id"),
                  );
                  const f = findings.find((x) => s(x, "id") === s(v, "finding_id"));
                  return (
                    <p key={s(e, "id")}>
                      “{s(e, "quote")}” → {s(f, "code")} v{s(v, "version_no")}{" "}
                      <span className="text-xs text-muted">
                        [{s(e, "quote_start")}–{s(e, "quote_end")}]
                      </span>
                    </p>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
