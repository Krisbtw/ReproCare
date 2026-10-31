import { useEffect, useMemo, useState } from "react";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { explainFinding, methodGap, sameMethodChange, type Measure } from "@/lib/reprotrace/engine";
import { highlightReport } from "@/lib/reprotrace/spans";
import { extractSurface, labelEllipsoid, analyticEllipsoidMl } from "@/lib/imaging/surface";
import { buildSyntheticMrDicom, readDicomBytes, type DicomRead } from "@/lib/dicom/codec";
import {
  addCycle,
  addLab,
  addReview,
  addSymptom,
  correctVersion,
  saveLabMeasurement,
  decideCorrespondence,
  exportRecord,
  getWorkspace,
  resetWorkspace,
  saveDicomMeta,
  setActivePatient,
  setMenarcheYear,
  setRole,
} from "@/lib/clinic/server";
import { explainPlain } from "@/lib/clinic/plain";
import { checkMenarcheYear, cycleBand, outsideBand, pcosContext } from "@/lib/clinic/pcos-context";
import { AnatomyStage, type AnatomyItem } from "./anatomy-stage";
import { CourseView } from "./course-view";
import { ResearchView } from "./research-view";
import { SliceBoard } from "./slice-board";
import { VolumeLab } from "./volume-lab";
import type { SliceMark } from "@/lib/imaging/phantom";
import type { Workspace } from "@/lib/clinic/types";

type View = "board" | "people" | "studio" | "lab" | "course" | "trace" | "context" | "methods" | "admin";

const NAV: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "people", label: "Records" },
  { id: "studio", label: "Studio" },
  { id: "lab", label: "Volume lab" },
  { id: "course", label: "Timeline" },
  { id: "trace", label: "ReproTrace" },
  { id: "context", label: "Context" },
  { id: "methods", label: "Methods" },
  { id: "admin", label: "Admin" },
];

type Bag = Record<string, unknown>;

const REGIONS = [
  "Lower abdomen — midline",
  "Right lower quadrant",
  "Left lower quadrant",
  "Low back",
  "Deep pelvis",
];

const REGION_POS: Record<string, [number, number, number]> = {
  "Lower abdomen — midline": [0, 0.9, 2.4],
  "Right lower quadrant": [-2.3, 0.5, 2.1],
  "Left lower quadrant": [2.3, 0.5, 2.1],
  "Low back": [0, 0.2, -2.5],
  "Deep pelvis": [0, -0.3, 0.3],
};

function s(row: object | undefined, key: string): string {
  if (!row) return "";
  const value = (row as Record<string, unknown>)[key];
  return value == null ? "" : String(value);
}
function num(row: object | undefined, key: string): number | null {
  if (!row) return null;
  const value = (row as Record<string, unknown>)[key];
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function triple(row: object | undefined, key: string): [number, number, number] | null {
  if (!row) return null;
  const value = (row as Record<string, unknown>)[key];
  if (!Array.isArray(value) || value.length !== 3) return null;
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}
function errText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

const LABELS: Record<string, string> = {
  likely_same: "Likely same finding",
  potentially_new: "Potentially new",
  possible_resolved: "Possible resolved",
  uncertain: "Uncertain correspondence",
  needs_review: "Needs clinician review",
  measurable_difference: "Measurable difference",
  method_difference: "Method difference",
  segmentation_disagreement: "Segmentation disagreement",
  reporting_inconsistency: "Reporting inconsistency",
  unresolved_uncertainty: "Unresolved uncertainty",
  demonstration_geometry: "Demonstration geometry",
  clinician_edit: "Clinician edit",
  classical_region_growing: "Volume lab (classical, not a model)",
  clinician_recorded: "Clinician-recorded",
  verified: "Clinician verified",
  rejected: "Rejected",
  needs_more_information: "Needs more information",
  accept: "Accepted as corresponding",
  reject: "Kept separate",
  defer: "Deferred",
};

function Chip({ children, tone = "ink" }: { children: string; tone?: "ink" | "pine" | "clay" }) {
  const cls =
    tone === "pine" ? "bg-pine-soft text-pine" : tone === "clay" ? "bg-clay-soft text-clay" : "bg-paper text-ink-soft";
  return <span className={`inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium ${cls}`}>{children}</span>;
}

function Button({
  children,
  onClick,
  tone = "pine",
  type = "button",
  disabled,
}: {
  children: string;
  onClick?: () => void;
  tone?: "pine" | "clay" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const cls =
    tone === "ghost"
      ? "border border-line bg-card text-ink"
      : tone === "clay"
        ? "bg-clay text-card"
        : "bg-pine text-card";
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`min-h-11 rounded-md px-3 text-sm font-medium ${cls} disabled:opacity-50`}>
      {children}
    </button>
  );
}

export function ClinicApp() {
  const user = useCurrentUser();
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("board");
  const [busy, setBusy] = useState(false);
  const [labOpened, setLabOpened] = useState(false);

  async function reload() {
    setData(await getWorkspace());
  }

  useEffect(() => {
    if (view === "lab") setLabOpened(true);
  }, [view]);

  useEffect(() => {
    let live = true;
    getWorkspace()
      .then((workspace) => {
        if (live) setData(workspace);
      })
      .catch((error: unknown) => {
        if (live) setError(errText(error));
      });
    return () => {
      live = false;
    };
  }, [user?.id]);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      await reload();
    } catch (error) {
      setError(errText(error));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <main className="mx-auto max-w-lg space-y-3 p-8">
        <h1 className="text-3xl">AnatomyBridge</h1>
        <p className="text-clay">{error}</p>
        <Button onClick={() => run(reload)}>Try again</Button>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="mx-auto max-w-3xl space-y-3 p-8">
        <p className="text-sm font-medium text-pine">AnatomyBridge</p>
        <h1 className="text-3xl">Opening the synthetic workspace</h1>
        <p className="text-muted">Loading records, evidence links, and the rules engine.</p>
      </main>
    );
  }

  const patients = data.patients as Bag[];
  const role = data.profile?.role ?? "clinician";
  const visiblePatients = role === "patient" ? patients.filter((p) => p.is_self === true) : patients;
  const activeId = visiblePatients.some((p) => s(p, "id") === data.profile?.active_patient_id)
    ? data.profile?.active_patient_id
    : s(visiblePatients[0], "id");
  const patient = visiblePatients.find((p) => s(p, "id") === activeId) ?? visiblePatients[0];

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      <nav className="flex gap-2 overflow-x-auto bg-ink p-3 lg:flex-col lg:overflow-visible">
        <div className="hidden px-2 py-3 lg:block">
          <p className="font-serif text-2xl text-card">AnatomyBridge</p>
          <p className="text-xs text-line">Evidence-linked reproductive review</p>
        </div>
        {NAV.filter((item) => !(item.id === "lab" && role === "patient")).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={`min-h-11 shrink-0 rounded-md px-3 text-left text-sm ${view === item.id ? "bg-pine text-card" : "text-line"}`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        <header className="flex flex-wrap items-center gap-3 border-b border-line bg-card px-4 py-3">
          <div className="mr-auto">
            <p className="font-serif text-xl lg:hidden">AnatomyBridge</p>
            <p className="text-xs text-muted">Synthetic records only. Not a diagnostic device.</p>
          </div>
          <label className="text-xs text-muted">
            Lens
            <select
              className="ml-2 min-h-11 rounded-md border border-line bg-paper px-2 text-sm text-ink"
              value={role}
              onChange={(event) => run(() => setRole({ data: event.target.value }))}
            >
              <option value="clinician">Clinician</option>
              <option value="patient">Patient</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          {patient && (
            <label className="text-xs text-muted">
              Record
              <select
                className="ml-2 min-h-11 max-w-48 rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={s(patient, "id")}
                onChange={(event) => run(() => setActivePatient({ data: event.target.value }))}
              >
                {visiblePatients.map((p) => (
                  <option key={s(p, "id")} value={s(p, "id")}>
                    {s(p, "display_name")}
                  </option>
                ))}
              </select>
            </label>
          )}
          <UserButton />
        </header>
        {error && <p className="bg-clay-soft px-4 py-2 text-sm text-clay">{error}</p>}
        <div className="space-y-6 p-4 lg:p-6">
          {view === "board" && <Board data={data} patients={visiblePatients} onOpen={(id) => { void run(() => setActivePatient({ data: id })); setView("studio"); }} />}
          {view === "people" && patient && <People data={data} patients={visiblePatients} active={patient} onOpen={(id) => { void run(() => setActivePatient({ data: id })); setView("studio"); }} />}
          {view === "studio" && patient && <Studio data={data} patient={patient} clinician={role !== "patient"} busy={busy} run={run} />}
          {labOpened && role !== "patient" && (
            <div hidden={view !== "lab"}>
              <VolumeLab
                findings={
                  patient
                    ? (data?.findings as Bag[])
                        .filter((f) => s(f, "patient_id") === s(patient, "id"))
                        .map((f) => ({ id: s(f, "id"), label: `${s(f, "code")} · ${s(f, "structure")}` }))
                    : []
                }
                onRecord={(task) => run(task)}
                recordFinding={(input) => saveLabMeasurement({ data: input })}
              />
            </div>
          )}
          {view === "lab" && role === "patient" && (
            <p className="rounded-lg border border-line bg-card p-4 text-ink-soft">The volume lab is a clinician tool. Switch the lens to Clinician to use it.</p>
          )}
          {view === "course" && patient && <CourseView data={data} patient={patient} onStudio={() => setView("studio")} />}
          {view === "trace" && patient && <Trace data={data} patient={patient} clinician={role !== "patient"} busy={busy} run={run} />}
          {view === "context" && patient && <Context data={data} patient={patient} busy={busy} run={run} />}
          {view === "methods" && <ResearchView />}
          {view === "admin" && <Admin data={data} role={role} busy={busy} run={run} patientId={s(patient, "id")} />}
        </div>
      </div>
    </div>
  );
}

function Board({ data, patients, onOpen }: { data: Workspace; patients: Bag[]; onOpen: (id: string) => void }) {
  const queue = data.correspondences.filter((c) => !data.decisions.some((d) => d.correspondence_id === c.id));
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-medium text-pine">Workspace</p>
        <h1 className="text-3xl">Four synthetic pathways, one evidence engine</h1>
        <p className="max-w-2xl text-ink-soft">
          Start with Meera if you want the fibroid demonstration. Every person here is invented. Imaging coordinates are schematic, not registered scans.
        </p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {patients.map((p) => (
          <button key={s(p, "id")} type="button" onClick={() => onOpen(s(p, "id"))} className="rounded-lg border border-line bg-card p-4 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl">{s(p, "display_name")}</h2>
              <Chip tone="clay">Synthetic</Chip>
              <Chip>{s(p, "pathway")}</Chip>
            </div>
            <p className="mt-2 text-sm text-ink-soft">{s(p, "synopsis")}</p>
          </button>
        ))}
      </div>
      <section className="rounded-lg border border-line bg-card p-4">
        <h2 className="text-xl">Open proposals</h2>
        <p className="mt-1 text-sm text-muted">{queue.length} correspondence proposals have no clinician decision yet. Decisions do not merge records.</p>
      </section>
    </div>
  );
}

function People({ data, patients, active, onOpen }: { data: Workspace; patients: Bag[]; active: Bag; onOpen: (id: string) => void }) {
  const studies = (data.studies as Bag[]).filter((st) => s(st, "patient_id") === s(active, "id"));
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2">
        {patients.map((p) => (
          <button key={s(p, "id")} type="button" onClick={() => onOpen(s(p, "id"))} className={`w-full min-h-11 rounded-md border px-3 py-2 text-left text-sm ${s(p, "id") === s(active, "id") ? "border-pine bg-pine-soft" : "border-line bg-card"}`}>
            {s(p, "display_name")}
            <span className="mt-1 block text-xs text-muted">{s(p, "code")} · {s(p, "pathway")}</span>
          </button>
        ))}
      </div>
      <article className="space-y-3 rounded-lg border border-line bg-card p-4">
        <h1 className="text-3xl">{s(active, "display_name")}</h1>
        <p className="text-sm text-ink-soft">{s(active, "synopsis")}</p>
        <p className="text-sm text-muted">Year of birth on the synthetic file: {s(active, "year_of_birth")}. Pathway: {s(active, "pathway")}.</p>
        <h2 className="text-xl">Studies</h2>
        <ul className="space-y-2 text-sm">
          {studies.map((st) => (
            <li key={s(st, "id")} className="rounded-md border border-line p-3">
              <span className="font-medium text-ink">{s(st, "study_date")} · {s(st, "modality")}</span>
              <span className="mt-1 block text-ink-soft">{s(st, "description")}. {s(st, "source_note")}</span>
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}

function Studio({
  data,
  patient,
  clinician,
  busy,
  run,
}: {
  data: Workspace;
  patient: Bag;
  clinician: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const studies = (data.studies as Bag[]).filter((st) => s(st, "patient_id") === s(patient, "id"));
  const [studyId, setStudyId] = useState(s(studies[studies.length - 1], "id"));
  const study = studies.find((st) => s(st, "id") === studyId) ?? studies[0];
  const findings = (data.findings as Bag[]).filter((f) => s(f, "patient_id") === s(patient, "id"));
  const versions = (data.versions as Bag[]).filter((v) => findings.some((f) => s(f, "id") === s(v, "finding_id")));
  const onStudy = versions.filter((v) => s(v, "study_id") === s(study, "id"));
  const latest = new Map<string, Bag>();
  for (const v of onStudy) {
    const prev = latest.get(s(v, "finding_id"));
    if (!prev || (num(v, "version_no") ?? 0) > (num(prev, "version_no") ?? 0)) latest.set(s(v, "finding_id"), v);
  }
  const current = [...latest.values()].sort((a, b) => {
    const codeA = s(findings.find((f) => s(f, "id") === s(a, "finding_id")), "code");
    const codeB = s(findings.find((f) => s(f, "id") === s(b, "finding_id")), "code");
    return codeA.localeCompare(codeB);
  });
  const [selected, setSelected] = useState<string | null>(current[0] ? s(current[0], "id") : null);
  const chosen = versions.find((v) => s(v, "id") === selected) ?? current[0];
  const finding = findings.find((f) => s(f, "id") === s(chosen, "finding_id"));
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [showSymptoms, setShowSymptoms] = useState(true);
  const [reason, setReason] = useState("Boundary adjusted against the stored report.");
  const [axes, setAxes] = useState("40, 36, 34");
  const [dicom, setDicom] = useState<DicomRead | null>(null);
  const [fileName, setFileName] = useState("");
  const [slice, setSlice] = useState(0);
  const [plain, setPlain] = useState<string | null>(null);
  const [plainNote, setPlainNote] = useState<string | null>(null);
  const [plainBusy, setPlainBusy] = useState(false);

  useEffect(() => {
    setStudyId(s(studies[studies.length - 1], "id"));
    setSelected(null);
    setPlain(null);
    setPlainNote(null);
    // patient switch only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s(patient, "id")]);

  const surface = useMemo(() => {
    const ax = triple(chosen, "axes_mm");
    if (!ax) return null;
    const radii: [number, number, number] = [ax[0] / 2, ax[1] / 2, ax[2] / 2];
    const n = 30;
    const spacing = (Math.max(...radii) * 2) / (n * 0.7);
    const grid = labelEllipsoid(n, spacing, radii);
    return { stats: extractSurface(grid, n, spacing), analytic: analyticEllipsoidMl(radii) };
  }, [chosen]);

  const items = useMemo(() => {
    const list: AnatomyItem[] = [
      { id: "uterus", kind: "uterus", position: [0, 0, 0], radii: [1, 1, 1], tone: "pine" },
      { id: "ovary-l", kind: "ovary", position: [3.6, 0.35, 0.2], radii: [0.7, 0.48, 0.55], tone: "pine" },
      { id: "ovary-r", kind: "ovary", position: [-3.6, 0.35, 0.2], radii: [0.7, 0.48, 0.55], tone: "pine" },
    ];
    if (s(patient, "pathway") === "pcos") {
      for (let i = 0; i < 6; i += 1) {
        list.push({
          id: `fol-${i}`,
          kind: "follicle",
          position: [3.4 + (i % 3) * 0.28, 0.2 + Math.floor(i / 3) * 0.28, 0.15],
          radii: [0.12, 0.12, 0.12],
          tone: "ink",
        });
      }
    }
    for (const v of current) {
      const c = triple(v, "centroid_mm");
      const ax = triple(v, "axes_mm");
      if (!c || !ax) continue;
      const kind = s(findings.find((f) => s(f, "id") === s(v, "finding_id")), "structure");
      const meshKind = kind === "cyst" ? "cyst" : kind === "endometriotic_lesion" ? "lesion" : "fibroid";
      list.push({
        id: s(v, "id"),
        kind: meshKind,
        position: [c[0] / 10, c[1] / 10, c[2] / 10],
        radii: [ax[0] / 20, ax[1] / 20, ax[2] / 20],
        tone: s(v, "id") === s(chosen, "id") ? "clay" : "ink",
      });
    }
    if (showSymptoms) {
      (data.symptoms as Bag[])
        .filter((sym) => s(sym, "patient_id") === s(patient, "id"))
        .forEach((sym) => {
          const pos = REGION_POS[s(sym, "region")];
          if (!pos) return;
          list.push({ id: `sym-${s(sym, "id")}`, kind: "symptom", position: pos, radii: [0.18, 0.18, 0.18], tone: "clay" });
        });
    }
    return list;
  }, [current, chosen, data.symptoms, findings, patient, showSymptoms]);

  const evidence = (data.evidence as Bag[]).filter((e) => s(e, "finding_version_id") === s(chosen, "id"));
  const history = versions.filter((v) => s(v, "finding_id") === s(chosen, "finding_id")).sort((a, b) => (num(a, "version_no") ?? 0) - (num(b, "version_no") ?? 0));
  const reviews = (data.reviews as Bag[]).filter((r) => s(r, "target_id") === s(chosen, "id"));
  const verified = reviews.some((r) => s(r, "status") === "verified");
  const quote = evidence.map((e) => s(e, "quote")).find(Boolean) ?? null;
  const explanation = explainFinding({
    structure: s(finding, "structure"),
    location: s(chosen, "location_label"),
    quote,
    axesMm: triple(chosen, "axes_mm"),
    basis: s(chosen, "measurement_basis"),
    verified,
    sourceName: LABELS[s(chosen, "segmentation_source")] ?? s(chosen, "segmentation_source"),
  });
  const report = (data.reports as Bag[]).find((r) => s(r, "id") === s(evidence[0], "report_id"));
  const series = (data.series as Bag[]).find((r) => r && s(r, "id") === s(evidence[0], "series_id"));
  const sliceCount = Math.max(1, num(series, "slice_count") ?? (s(study, "modality") === "MR" ? 28 : 1));
  const marks: SliceMark[] = current.map((v) => {
    const link = (data.evidence as Bag[]).find((e) => s(e, "finding_version_id") === s(v, "id"));
    return {
      id: s(v, "id"),
      slice: num(link, "slice_index"),
      centroidMm: triple(v, "centroid_mm"),
      radiiMm: triple(v, "axes_mm"),
      selected: s(v, "id") === s(chosen, "id"),
    };
  });

  useEffect(() => {
    const stored = num(evidence[0], "slice_index");
    if (stored != null) setSlice(stored);
    setPlain(null);
    setPlainNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s(chosen, "id")]);

  function measureOf(v: Bag): Measure {
    return {
      id: s(v, "id"),
      findingId: s(v, "finding_id"),
      date: s(v, "observed_on"),
      modality: s(v, "modality"),
      basis: s(v, "measurement_basis"),
      locationLabel: s(v, "location_label"),
      longestMm: num(v, "longest_mm"),
      axesMm: triple(v, "axes_mm"),
      source: s(v, "segmentation_source"),
      reportLongestMm: num(v, "report_longest_mm"),
      quality: s(v, "quality"),
    };
  }
  const comparisons = chosen
    ? versions.flatMap((v) => {
        if (s(v, "id") === s(chosen, "id") || s(v, "location_label") !== s(chosen, "location_label")) return [];
        const gap = methodGap(measureOf(chosen), measureOf(v)) ?? sameMethodChange(measureOf(chosen), measureOf(v));
        if (!gap) return [];
        const code = s(findings.find((f) => s(f, "id") === s(v, "finding_id")), "code");
        return [{ id: s(v, "id"), code, gap }];
      })
    : [];

  async function onFile(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    setDicom(await readDicomBytes(bytes));
    setFileName(file.name);
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-pine">Imaging studio · {s(patient, "display_name")}</p>
          <h1 className="text-3xl">Anatomy, source, and measurement</h1>
        </div>
        <label className="text-xs text-muted">
          Study
          <select className="ml-2 min-h-11 rounded-md border border-line bg-card px-2 text-sm text-ink" value={s(study, "id")} onChange={(e) => { setStudyId(e.target.value); setSelected(null); }}>
            {studies.map((st) => (
              <option key={s(st, "id")} value={s(st, "id")}>{s(st, "study_date")} · {s(st, "modality")}</option>
            ))}
          </select>
        </label>
      </header>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.8fr)]">
        <section className="overflow-hidden rounded-lg border border-line bg-card">
          <div className="flex flex-wrap gap-2 border-b border-line p-3">
            {(["uterus", "ovary", "fibroid", "lesion", "cyst", "follicle"] as const).map((kind) => (
              <button key={kind} type="button" className="min-h-11 rounded-md border border-line px-3 text-xs" onClick={() => setHidden((h) => ({ ...h, [kind]: !h[kind] }))}>
                {hidden[kind] ? `Show ${kind}` : `Hide ${kind}`}
              </button>
            ))}
            <button type="button" className="min-h-11 rounded-md border border-line px-3 text-xs" onClick={() => setShowSymptoms((v) => !v)}>
              {showSymptoms ? "Hide symptoms" : "Show symptoms"}
            </button>
          </div>
          <div className="h-96">
            <AnatomyStage
              items={items}
              selectedId={s(chosen, "id") || null}
              onSelect={(id) => {
                if (id?.startsWith("sym-")) return;
                setSelected(id);
              }}
              hidden={hidden}
              surface={surface?.stats ?? null}
            />
          </div>
          <div className="border-t border-line p-3">
            {s(study, "modality") === "MR" ? (
              <SliceBoard
                slice={slice}
                sliceCount={sliceCount}
                marks={marks}
                onSlice={setSlice}
                plane={s(series, "plane")}
              />
            ) : (
              <p className="text-sm text-muted">
                This study has no volumetric stack in the record. Measurements stay as numbers. They are not placed on the MRI slices.
              </p>
            )}
          </div>
          <p className="border-t border-line px-3 py-2 text-xs text-muted">
            Drag to rotate. Scroll or pinch to zoom. +X is patient left, +Y cranial, +Z anterior. The model is a schematic. Symptom markers are patient-reported and do not prove a nearby finding caused the symptom.
            {s(patient, "pathway") === "pcos" && " Follicle dots are illustrative, not the recorded count."}
          </p>
        </section>
        <aside className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {current.map((v) => (
              <button key={s(v, "id")} type="button" onClick={() => setSelected(s(v, "id"))} className={`min-h-11 rounded-md border px-3 text-sm ${s(v, "id") === s(chosen, "id") ? "border-pine bg-pine-soft" : "border-line bg-card"}`}>
                {s(findings.find((f) => s(f, "id") === s(v, "finding_id")), "code")}
              </button>
            ))}
            {current.length === 0 && <p className="text-sm text-muted">No spatially placed finding on this study. Ultrasound measurements may be numbers only.</p>}
          </div>
          {chosen && (
            <article className="space-y-3 rounded-lg border border-line bg-card p-4">
              <div className="flex flex-wrap gap-2">
                <Chip tone="clay">Synthetic</Chip>
                <Chip tone={verified ? "pine" : "clay"}>{verified ? "Clinician verified" : "Not verified"}</Chip>
                <Chip>{LABELS[s(chosen, "segmentation_source")] ?? s(chosen, "segmentation_source")}</Chip>
              </div>
              <h2 className="text-2xl">{s(finding, "code")} · {s(finding, "structure").replaceAll("_", " ")}</h2>
              <p className="text-sm text-ink-soft">{s(chosen, "location_label")}{s(chosen, "figo") ? ` · FIGO label stored as ${s(chosen, "figo")}` : ""}. The FIGO label was entered with the record. This software did not classify it.</p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div><dt className="text-muted">Longest axis</dt><dd className="tabular-nums">{num(chosen, "longest_mm") ?? "—"} mm</dd></div>
                <div><dt className="text-muted">Basis</dt><dd>{s(chosen, "measurement_basis")}</dd></div>
                <div><dt className="text-muted">Frame</dt><dd>{s(chosen, "frame").replaceAll("_", " ")}</dd></div>
                <div><dt className="text-muted">Quality</dt><dd>{s(chosen, "quality")}</dd></div>
              </dl>
              <div className="space-y-2 border-t border-line pt-3">
                <h3 className="text-lg">Plain-language note</h3>
                {explanation.insufficient && <p className="text-sm text-clay">Source text is insufficient for a fuller explanation. Nothing extra was invented.</p>}
                {explanation.paragraphs.map((p) => (
                  <p key={p.text} className="text-sm text-ink-soft">{p.text} <span className="text-muted">({p.source})</span></p>
                ))}
                {quote && clinician && (
                  <Button
                    tone="ghost"
                    disabled={plainBusy}
                    onClick={() => {
                      setPlainBusy(true);
                      setPlainNote(null);
                      void explainPlain({
                        data: {
                          structure: s(finding, "structure").replaceAll("_", " "),
                          location: s(chosen, "location_label"),
                          quote,
                          measurement: triple(chosen, "axes_mm")?.map((n) => `${n} mm`).join(" × ") ?? "",
                          basis: s(chosen, "measurement_basis"),
                          verified,
                        },
                      })
                        .then((result) => {
                          setPlain(result.text);
                          setPlainNote(result.note);
                        })
                        .catch((error: unknown) => setPlainNote(errText(error)))
                        .finally(() => setPlainBusy(false));
                    }}
                  >
                    {plainBusy ? "Rewriting…" : "Rewrite excerpt in plain language"}
                  </Button>
                )}
                {plain && <p className="text-sm text-ink">{plain}</p>}
                {plainNote && <p className="text-xs text-muted">{plainNote}</p>}
              </div>
            </article>
          )}
        </aside>
      </div>
      {chosen && (
        <div className="grid gap-4 lg:grid-cols-3">
          <article className="space-y-2 rounded-lg border border-line bg-card p-4">
            <h2 className="text-xl">Evidence</h2>
            <p className="text-sm text-ink-soft">Series: {series ? `${s(series, "description")}, ${s(series, "plane") || "plane not stored"}, ${s(series, "slice_count") || "?"} slices` : "No series link."}</p>
            <p className="text-sm text-ink-soft">Slice index on file: {s(evidence[0], "slice_index") || "not stored"}.</p>
            {num(evidence[0], "slice_index") != null && (
              <Button tone="ghost" onClick={() => setSlice(num(evidence[0], "slice_index") ?? 0)}>
                Show stored slice
              </Button>
            )}
            <p className="text-sm text-ink-soft">
              {report
                ? highlightReport(s(report, "body")).map((part, index) =>
                    part.mark ? (
                      <mark key={index} className="rounded-sm bg-pine-soft text-ink">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )
                : "No report is linked."}
            </p>
            <p className="text-xs text-muted">Highlighted phrases were matched in the stored report. Nothing was added.</p>
          </article>
          <article className="space-y-2 rounded-lg border border-line bg-card p-4">
            <h2 className="text-xl">Versions</h2>
            <ol className="space-y-2 text-sm">
              {history.map((v) => (
                <li key={s(v, "id")}>
                  <button type="button" className="text-left" onClick={() => setSelected(s(v, "id"))}>
                    <span className="font-medium text-ink">v{s(v, "version_no")} · {LABELS[s(v, "segmentation_source")] ?? s(v, "segmentation_source")}</span>
                    <span className="block text-ink-soft">{s(v, "change_reason")}</span>
                  </button>
                </li>
              ))}
            </ol>
            {clinician && triple(chosen, "axes_mm") && (
              <form className="space-y-2 border-t border-line pt-3" onSubmit={(e) => {
                e.preventDefault();
                const parsed = axes.split(",").map((part) => Number(part.trim())) as [number, number, number];
                void run(() => correctVersion({ data: { versionId: s(chosen, "id"), axes: parsed, reason } }));
              }}>
                <p className="text-xs text-muted">New version. The previous one stays.</p>
                <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm" value={axes} onChange={(e) => setAxes(e.target.value)} aria-label="Axes in millimetres" />
                <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for the edit" />
                <Button type="submit" disabled={busy}>Save edit as new version</Button>
              </form>
            )}
            {clinician && (
              <Button tone="ghost" disabled={busy} onClick={() => run(() => addReview({ data: { targetType: "finding_version", targetId: s(chosen, "id"), status: "verified", note: "Checked against the stored report excerpt." } }))}>
                Mark this version verified
              </Button>
            )}
            {comparisons.length > 0 && (
              <div className="space-y-2 border-t border-line pt-3">
                <h3 className="text-lg">Same label, other study</h3>
                {comparisons.map((item) => (
                  <p key={item.id} className="text-sm text-ink-soft">
                    <span className="font-medium text-ink">{LABELS[item.gap.category] ?? item.gap.category}</span>
                    {" · "}
                    {item.code}. {item.gap.detail}
                  </p>
                ))}
              </div>
            )}
          </article>
          <article className="space-y-2 rounded-lg border border-line bg-card p-4">
            <h2 className="text-xl">Surface check</h2>
            {surface ? (
              <>
                <p className="text-sm text-ink-soft">Cuberille surface from a synthetic ellipsoid label. Components: {surface.stats.componentCount}. Triangles: {surface.stats.triangleCount}.</p>
                <p className="text-sm tabular-nums text-ink-soft">Voxel volume {surface.stats.volumeMl.toFixed(2)} ml. Analytic ellipsoid {surface.analytic.toFixed(2)} ml. Difference {((Math.abs(surface.stats.volumeMl - surface.analytic) / surface.analytic) * 100).toFixed(1)}%.</p>
                <p className="text-sm text-muted">Dice and HD95 are not shown. There is no expert reference mask.</p>
              </>
            ) : (
              <p className="text-sm text-muted">This observation has no three-axis size, so no surface was built.</p>
            )}
            <h3 className="pt-2 text-lg">DICOM header</h3>
            <div className="flex flex-wrap gap-2">
              <Button tone="ghost" onClick={() => { void readDicomBytes(buildSyntheticMrDicom()).then((read) => { setDicom(read); setFileName("synthetic-phantom.dcm"); }); }}>Load sample DICOM</Button>
              <label className="min-h-11 cursor-pointer rounded-md border border-line bg-card px-3 py-2 text-sm">
                Upload DICOM
                <input className="sr-only" type="file" accept=".dcm,application/dicom" onChange={(e) => { const file = e.target.files?.[0]; if (file) void onFile(file); }} />
              </label>
            </div>
            {dicom && <DicomCard read={dicom} onSave={() => run(() => saveDicomMeta({ data: { patientId: s(patient, "id"), fileName, transferSyntax: dicom.transferSyntax, metadata: dicom.metadata, warnings: dicom.warnings } }))} />}
          </article>
        </div>
      )}
    </div>
  );
}

function DicomCard({ read, onSave }: { read: DicomRead; onSave: () => void }) {
  return (
    <div className="space-y-2">
      {read.pixels && read.rows > 0 && (
        <canvas
          className="h-28 w-28 border border-line"
          width={read.cols}
          height={read.rows}
          ref={(node) => {
            if (!node || !read.pixels) return;
            const ctx = node.getContext("2d");
            if (!ctx) return;
            const image = new ImageData(new Uint8ClampedArray(read.pixels), read.cols, read.rows);
            ctx.putImageData(image, 0, 0);
          }}
        />
      )}
      <ul className="space-y-1 text-xs text-ink-soft">
        {Object.entries(read.metadata).map(([key, value]) => (
          <li key={key}><span className="text-muted">{key}: </span>{value}</li>
        ))}
      </ul>
      {read.warnings.map((w) => <p key={w} className="text-xs text-clay">{w}</p>)}
      <Button tone="ghost" onClick={onSave}>Save metadata only</Button>
    </div>
  );
}

function Trace({
  data,
  patient,
  clinician,
  busy,
  run,
}: {
  data: Workspace;
  patient: Bag;
  clinician: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const pid = s(patient, "id");
  const rows = (data.correspondences as Bag[]).filter((c) => s(c, "patient_id") === pid);
  const discs = (data.discrepancies as Bag[]).filter((d) => s(d, "patient_id") === pid);
  const decisions = data.decisions as Bag[];
  const versions = data.versions as Bag[];
  const label = (id: string) => {
    const v = versions.find((item) => s(item, "id") === id);
    const f = (data.findings as Bag[]).find((item) => s(item, "id") === s(v, "finding_id"));
    return v ? `${s(f, "code")} v${s(v, "version_no")} (${s(v, "observed_on")})` : "—";
  };
  return (
    <div className="space-y-4">
      <header>
        <p className="text-sm font-medium text-pine">ReproTrace · {data.engineVersion}</p>
        <h1 className="text-3xl">Correspondence and disagreement</h1>
        <p className="max-w-2xl text-sm text-ink-soft">Proposals are not merges. A schematic coordinate frame stays provisional even when the geometry looks close. Rules live in the Methods page.</p>
      </header>
      <div className="grid gap-3">
        {rows.map((row) => {
          const decision = [...decisions].reverse().find((d) => s(d, "correspondence_id") === s(row, "id"));
          return (
            <article key={s(row, "id")} className="space-y-2 rounded-lg border border-line bg-card p-4">
              <div className="flex flex-wrap gap-2">
                <Chip tone="clay">{LABELS[s(row, "category")] ?? s(row, "category")}</Chip>
                {row.provisional === true && <Chip>Provisional</Chip>}
                {decision && <Chip tone="pine">{LABELS[s(decision, "decision")] ?? s(decision, "decision")}</Chip>}
              </div>
              <p className="text-sm text-ink">{label(s(row, "from_version_id"))} → {label(s(row, "to_version_id"))}</p>
              <p className="text-sm text-ink-soft">{s(row, "rationale")}</p>
              <p className="text-xs tabular-nums text-muted">Score {num(row, "score") ?? "—"} · {s(row, "engine_version")}</p>
              {clinician && (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => run(() => decideCorrespondence({ data: { correspondenceId: s(row, "id"), decision: "accept", note: "Clinician agrees the observations correspond. Rows were not merged." } }))}>Accept link</Button>
                  <Button tone="ghost" disabled={busy} onClick={() => run(() => decideCorrespondence({ data: { correspondenceId: s(row, "id"), decision: "reject", note: "Keep as separate observations." } }))}>Keep separate</Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      <h2 className="text-2xl">Discrepancies</h2>
      <div className="grid gap-3">
        {discs.map((d) => (
          <article key={s(d, "id")} className="rounded-lg border border-line bg-card p-4">
            <Chip tone="clay">{LABELS[s(d, "category")] ?? s(d, "category")}</Chip>
            <h3 className="mt-2 text-lg">{s(d, "summary")}</h3>
            <p className="text-sm text-ink-soft">{s(d, "detail")}</p>
          </article>
        ))}
        {discs.length === 0 && <p className="text-sm text-muted">No discrepancy rule fired for this record.</p>}
      </div>
    </div>
  );
}

function Context({
  data,
  patient,
  busy,
  run,
}: {
  data: Workspace;
  patient: Bag;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const pid = s(patient, "id");
  const symptoms = (data.symptoms as Bag[]).filter((x) => s(x, "patient_id") === pid);
  const cycles = (data.cycles as Bag[]).filter((x) => s(x, "patient_id") === pid);
  const labs = (data.labs as Bag[]).filter((x) => s(x, "patient_id") === pid);
  const yob = num(patient, "year_of_birth");
  const storedMenarche = num(patient, "menarche_year");
  const thisYear = new Date().getFullYear();
  const isPcos = s(patient, "pathway") === "pcos";
  const pcos = isPcos ? pcosContext(yob, thisYear, storedMenarche) : null;
  const band = pcos ? cycleBand(pcos.gynAge) : null;
  const [menarcheText, setMenarcheText] = useState(storedMenarche == null ? "" : String(storedMenarche));
  const [menarcheReason, setMenarcheReason] = useState("");
  const [menarcheProblem, setMenarcheProblem] = useState<string | null>(null);
  useEffect(() => {
    setMenarcheText(storedMenarche == null ? "" : String(storedMenarche));
    setMenarcheProblem(null);
  }, [pid, storedMenarche]);
  function saveMenarche(clear: boolean) {
    const value = clear ? null : Number(menarcheText);
    if (value !== null) {
      const check = checkMenarcheYear(value, yob, thisYear);
      if (!check.ok) {
        setMenarcheProblem(check.problem);
        return;
      }
    }
    if (menarcheReason.trim().length < 4) {
      setMenarcheProblem("Say where the year came from (for example: patient-reported at visit).");
      return;
    }
    setMenarcheProblem(null);
    void run(() => setMenarcheYear({ data: { patientId: pid, menarcheYear: value, reason: menarcheReason } }));
    setMenarcheReason("");
  }
  const [region, setRegion] = useState(REGIONS[0]);
  const [intensity, setIntensity] = useState(4);
  const [description, setDescription] = useState("");
  const [flow, setFlow] = useState("moderate");
  const [lengthDays, setLengthDays] = useState(32);
  const [note, setNote] = useState("");
  const [analyte, setAnalyte] = useState("");
  const [valueText, setValueText] = useState("");
  const [unit, setUnit] = useState("");
  return (
    <div className="space-y-4">
      <header>
        <p className="text-sm font-medium text-pine">Context · {s(patient, "display_name")}</p>
        <h1 className="text-3xl">Symptoms, cycles, and labs</h1>
        <p className="max-w-2xl text-sm text-ink-soft">Patient-reported entries stay labeled as such. Nothing here diagnoses PCOS, endometriosis, or any other condition. The 2023 international PCOS guideline is the reason ovarian appearance is not treated as a diagnosis by itself.</p>
      </header>
      {pcos && (
        <aside role="note" aria-label="PCOS context" className="rounded-lg border border-line bg-card p-4 text-sm">
          <p className="font-medium text-ink">{pcos.headline}</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
            {pcos.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="mt-2 text-xs text-muted" data-testid="pcos-basis">
            Based on: {pcos.basis === "menarche" ? "stored first-period year" : pcos.basis === "birth-year" ? "year of birth only (app threshold)" : "nothing usable"}. Source: 2023 international PCOS guideline, as summarised in docs/RESEARCH_REPORT.md.
          </p>
        </aside>
      )}
      {isPcos && (
        <section className="space-y-2 rounded-lg border border-line bg-card p-4" aria-label="Year of first period">
          <h2 className="text-xl">Year of first period</h2>
          <p className="text-sm text-ink-soft">
            Stored as a year only. Currently: <span className="font-medium text-ink" data-testid="menarche-stored">{storedMenarche ?? "not recorded"}</span>. Every change is written to the audit log with the earlier value.
          </p>
          <form className="grid gap-2 md:grid-cols-[8rem_minmax(0,1fr)_auto_auto]" onSubmit={(e) => { e.preventDefault(); saveMenarche(false); }}>
            <input className="min-h-11 rounded-md border border-line bg-paper px-2" inputMode="numeric" placeholder="e.g. 2011" aria-label="Year of first period" value={menarcheText} onChange={(e) => setMenarcheText(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} />
            <input className="min-h-11 rounded-md border border-line bg-paper px-2" placeholder="Source, e.g. patient-reported at visit" aria-label="Source of the year" value={menarcheReason} onChange={(e) => setMenarcheReason(e.target.value)} />
            <Button type="submit" disabled={busy || menarcheText.length !== 4}>Save year</Button>
            <Button tone="ghost" disabled={busy || storedMenarche == null} onClick={() => saveMenarche(true)}>Clear</Button>
          </form>
          {menarcheProblem && <p role="alert" className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">{menarcheProblem}</p>}
        </section>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-line bg-card p-4">
          <h2 className="text-xl">Symptoms</h2>
          <ul className="space-y-2 text-sm">
            {symptoms.map((sym) => (
              <li key={s(sym, "id")} className="border-b border-line pb-2">
                <span className="font-medium text-ink">{s(sym, "recorded_on")} · {s(sym, "region")} · {s(sym, "intensity")}/10</span>
                <span className="block text-ink-soft">{s(sym, "description")}</span>
                <span className="text-xs text-muted">Source: {s(sym, "source").replaceAll("_", " ")}</span>
              </li>
            ))}
          </ul>
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => addSymptom({ data: { patientId: pid, region, intensity, cycleDay: null, description, recordedOn: new Date().toISOString().slice(0, 10) } })); setDescription(""); }}>
            <select className="min-h-11 rounded-md border border-line bg-paper px-2" value={region} onChange={(e) => setRegion(e.target.value)}>{REGIONS.map((r) => <option key={r}>{r}</option>)}</select>
            <label className="text-sm text-muted">Intensity {intensity}
              <input className="mt-1 w-full" type="range" min={0} max={10} value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} />
            </label>
            <input className="min-h-11 rounded-md border border-line bg-paper px-2" placeholder="What was noticed" value={description} onChange={(e) => setDescription(e.target.value)} />
            <Button type="submit" disabled={busy}>Add symptom</Button>
          </form>
        </section>
        <section className="space-y-3 rounded-lg border border-line bg-card p-4">
          <h2 className="text-xl">Cycles</h2>
          {cycles.length > 0 && (
            <div className="flex h-28 items-end gap-2">
              {cycles.map((c) => (
                <div key={s(c, "id")} className="flex-1 rounded-sm bg-pine" style={{ height: `${Math.min(100, (num(c, "length_days") ?? 0) * 1.6)}%` }} title={`${s(c, "length_days")} days`} />
              ))}
            </div>
          )}
          {band && (
            <p className="rounded-md bg-paper px-3 py-2 text-xs text-ink-soft" data-testid="cycle-band">
              {band.status === "band" ? `Guideline range shown for reading only. ${band.label} The app does not label anyone from this.` : band.reason}
            </p>
          )}
          <ul className="space-y-1 text-sm text-ink-soft">
            {cycles.map((c) => {
              const out = band ? outsideBand(num(c, "length_days"), band) : null;
              return (
                <li key={s(c, "id")}>
                  {s(c, "start_date")} · {s(c, "length_days")} days · {s(c, "flow")}. {s(c, "note")}
                  {out === true && <span className="ml-2"><Chip tone="clay">Outside guideline range</Chip></span>}
                </li>
              );
            })}
          </ul>
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => addCycle({ data: { patientId: pid, startDate: new Date().toISOString().slice(0, 10), lengthDays, flow, note } })); }}>
            <input className="min-h-11 rounded-md border border-line bg-paper px-2" type="number" min={1} max={120} value={lengthDays} onChange={(e) => setLengthDays(Number(e.target.value))} aria-label="Cycle length in days" />
            <input className="min-h-11 rounded-md border border-line bg-paper px-2" value={flow} onChange={(e) => setFlow(e.target.value)} aria-label="Flow" />
            <input className="min-h-11 rounded-md border border-line bg-paper px-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" />
            <Button type="submit" disabled={busy}>Add cycle</Button>
          </form>
        </section>
      </div>
      <section className="space-y-3 rounded-lg border border-line bg-card p-4">
        <h2 className="text-xl">Laboratory values</h2>
        <ul className="space-y-1 text-sm">
          {labs.map((lab) => (
            <li key={s(lab, "id")} className="text-ink-soft"><span className="text-ink">{s(lab, "analyte")}</span> {s(lab, "value_text")} {s(lab, "unit")} on {s(lab, "observed_on")}. {s(lab, "source_note")}</li>
          ))}
          {labs.length === 0 && <li className="text-muted">No laboratory values stored for this record.</li>}
        </ul>
        <form className="grid gap-2 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void run(() => addLab({ data: { patientId: pid, observedOn: new Date().toISOString().slice(0, 10), analyte, valueText, unit, referenceText: "" } })); }}>
          <input className="min-h-11 rounded-md border border-line bg-paper px-2" placeholder="Analyte" value={analyte} onChange={(e) => setAnalyte(e.target.value)} />
          <input className="min-h-11 rounded-md border border-line bg-paper px-2" placeholder="Value" value={valueText} onChange={(e) => setValueText(e.target.value)} />
          <input className="min-h-11 rounded-md border border-line bg-paper px-2" placeholder="Unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
          <Button type="submit" disabled={busy}>Add lab</Button>
        </form>
      </section>
    </div>
  );
}

function Admin({
  data,
  role,
  busy,
  run,
  patientId,
}: {
  data: Workspace;
  role: string;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  patientId: string;
}) {
  return (
    <div className="space-y-4">
      <header>
        <p className="text-sm font-medium text-pine">Administration</p>
        <h1 className="text-3xl">Models, consent, audit, export</h1>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {(data.models as { id: string; name: string; status: string; note: string }[]).map((model) => (
          <article key={model.id} className="rounded-lg border border-line bg-card p-4">
            <div className="flex flex-wrap gap-2"><h2 className="text-lg">{model.name}</h2><Chip tone={model.status === "not_connected" ? "clay" : "pine"}>{model.status.replaceAll("_", " ")}</Chip></div>
            <p className="mt-2 text-sm text-ink-soft">{model.note}</p>
          </article>
        ))}
      </div>
      <section className="space-y-2 rounded-lg border border-line bg-card p-4">
        <h2 className="text-xl">Recent audit</h2>
        <ul className="space-y-1 text-sm text-ink-soft">
          {(data.audit as Bag[]).map((event) => (
            <li key={s(event, "id")}>{s(event, "at")} · {s(event, "action")} · {s(event, "detail")}</li>
          ))}
        </ul>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button tone="ghost" disabled={busy || !patientId} onClick={() => run(async () => {
          const payload = await exportRecord({ data: patientId });
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = "anatomybridge-synthetic.json";
          link.click();
          URL.revokeObjectURL(url);
        })}>Export active record</Button>
        {role === "admin" && <Button tone="clay" disabled={busy} onClick={() => run(() => resetWorkspace())}>Reset synthetic workspace</Button>}
      </div>
      <p className="text-xs text-muted">Uploaded DICOM headers stored: {(data.uploads as Bag[]).length}. Identifiers are withheld. Pixel data is not in the database.</p>
    </div>
  );
}
