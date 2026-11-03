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
  recomputeCorrespondence,
  resolveReportObservation,
  seedReproTraceDemo,
  registerReproTraceDemo,
  exportRecord,
  getWorkspace,
  resetWorkspace,
  saveDicomMeta,
  setActivePatient,
  setMenarcheYear,
  setRole,
  uploadReport,
  linkReportEvidence,
  requestClinicianVerification,
  verifyClinician,
  saveFibroidAssessment,
  saveEndometriosisRecord,
  saveOvarianCystRecord,
  savePcosAssessment,
  reviewPathwayRecord,
  grantPatientConsent,
  revokePatientConsent,
  reviewReportExtraction,
  decideReportFinding,
  interpretClinicalReport,
  askClinicalReportQuestion,
} from "@/lib/clinic/server";
import {
  ALL_CLINICIAN_PERMISSIONS,
  DEFAULT_CLINICIAN_PERMISSIONS,
} from "@/lib/clinic/types";
import { explainPlain } from "@/lib/clinic/plain";
import { checkMenarcheYear, cycleBand, outsideBand, pcosContext } from "@/lib/clinic/pcos-context";
import { AnatomyStage, type AnatomyItem } from "./anatomy-stage";
import { CourseView } from "./course-view";
import { ResearchView } from "./research-view";
import { SliceBoard } from "./slice-board";
import { VolumeLab, type SourceRequest } from "./volume-lab";
import { ReportsView } from "./reports-view";
import { EvidenceSummaryPanel, EvidenceTrail, FindingHistory, PatientTimeline, TraceReview } from "./reprotrace-panels";
import { LongitudinalTrends, type FindingHistoryPoint, type DiscrepancyItem } from "./longitudinal-trends";
import type { SliceMark } from "@/lib/imaging/phantom";
import type { Workspace } from "@/lib/clinic/types";

type View = "board" | "people" | "studio" | "reports" | "lab" | "course" | "trace" | "context" | "methods" | "admin";

const NAV: { id: View; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "people", label: "Records" },
  { id: "studio", label: "Studio" },
  { id: "reports", label: "Reports" },
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
  // Must be declared before any early return (React hook order).
  const [lens, setLens] = useState<string | null>(null);
  const [reportFocus, setReportFocus] = useState<{ reportId: string; start: number | null; end: number | null; nonce: number } | null>(null);
  const [labDemo, setLabDemo] = useState<SourceRequest | null>(null);
  const [studioVersion, setStudioVersion] = useState<{ id: string; nonce: number } | null>(null);

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
  const activeLens = lens ?? role;
  const isVerifiedClinician =
    (role === "admin" && (activeLens === "admin" || activeLens === "clinician")) ||
    (role === "clinician" && activeLens !== "patient" &&
      (data.profile?.is_verified_clinician !== undefined
        ? Boolean(data.profile.is_verified_clinician)
        : (data.verifications ?? []).some(
            (v) => v.user_id === data.profile?.user_id && (v.status === "verified" || v.status === "approved"),
          )));
  const visiblePatients = (!isVerifiedClinician || activeLens === "patient") ? patients.filter((p) => p.is_self === true) : patients;
  const activeId = visiblePatients.some((p) => s(p, "id") === data.profile?.active_patient_id)
    ? data.profile?.active_patient_id
    : s(visiblePatients[0], "id");
  const patient = visiblePatients.find((p) => s(p, "id") === activeId) ?? visiblePatients[0];

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      <nav className="flex gap-2 overflow-x-auto bg-ink p-3 lg:sticky lg:top-0 lg:h-screen lg:flex-col lg:overflow-y-auto lg:self-start shrink-0">
        <div className="hidden px-2 py-3 lg:block">
          <p className="font-serif text-2xl text-card">AnatomyBridge</p>
          <p className="text-xs text-line">Evidence-linked reproductive review</p>
        </div>
        {NAV.filter((item) => !(item.id === "lab" && !isVerifiedClinician)).map((item) => (
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
              value={activeLens}
              onChange={async (event) => {
                const target = event.target.value;
                setLens(target);
                try {
                  await setRole({ data: target });
                  await reload();
                } catch {
                  // Admin/clinician lens simulation safely adapts perspective without error crash
                }
              }}
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
          {view === "people" && patient && <People data={data} patients={visiblePatients} active={patient} busy={busy} run={run} onOpen={(id) => { void run(() => setActivePatient({ data: id })); setView("studio"); }} />}
          {view === "studio" && patient && (
            <Studio
              data={data}
              patient={patient}
              clinician={isVerifiedClinician}
              busy={busy}
              run={run}
              focusVersion={studioVersion}
              onOpenReport={(reportId, start, end) => {
                setReportFocus({ reportId, start, end, nonce: Date.now() });
                setView("reports");
              }}
              onOpenSlice={(versionId, _studyId, seriesId, slice, examKey) => {
                setLabDemo({ examKey, slice, nonce: Date.now(), patientId: s(patient, "id"), findingVersionId: versionId, seriesId });
                setView("lab");
              }}
            />
          )}
          {labOpened && isVerifiedClinician && (
            <div hidden={view !== "lab"}>
              <VolumeLab
                patientId={patient ? s(patient, "id") : undefined}
                findings={
                  patient
                    ? (data?.findings as Bag[])
                        .filter((f) => s(f, "patient_id") === s(patient, "id"))
                        .map((f) => ({ id: s(f, "id"), label: `${s(f, "code")} · ${s(f, "structure")}` }))
                    : []
                }
                onRecord={(task) => run(task)}
                recordFinding={(input) => saveLabMeasurement({ data: input })}
                openDemo={labDemo}
                onOpenEvidence={(id) => {
                  setStudioVersion({ id, nonce: Date.now() });
                  setView("studio");
                }}
              />
            </div>
          )}
          {view === "lab" && !isVerifiedClinician && (
            <p className="rounded-lg border border-line bg-card p-4 text-ink-soft">The volume lab is a verified clinician tool. Submit and obtain administrator approval in Admin to use it.</p>
          )}
          {view === "reports" && patient && (
            <ReportsView
              data={data}
              patient={patient}
              clinician={isVerifiedClinician}
              busy={busy}
              run={run}
              upload={(input) => uploadReport({ data: input })}
              link={(input) => linkReportEvidence({ data: input })}
              onReviewExtraction={(input) => reviewReportExtraction({ data: input })}
              onDecideFinding={(input) => decideReportFinding({ data: input })}
              onInterpretReport={(reportId) => interpretClinicalReport({ data: { reportId } })}
              onAskReportQuestion={(reportId, question) => askClinicalReportQuestion({ data: { reportId, question } })}
              onResolveObservation={(input) => resolveReportObservation({ data: input })}
              focus={reportFocus}
            />
          )}
          {view === "course" && patient && <CourseView data={data} patient={patient} onStudio={() => setView("studio")} />}
          {view === "trace" && patient && (
            <TraceReview
              data={data}
              patient={patient}
              clinician={isVerifiedClinician}
              busy={busy}
              run={run}
              recompute={(patientId) => recomputeCorrespondence({ data: patientId })}
              decide={(input) => decideCorrespondence({ data: input })}
              seedDemo={() => seedReproTraceDemo()}
              registerDemo={(patientId) => registerReproTraceDemo({ data: patientId })}
              review={(input) => addReview({ data: input })}
              onOpenVersion={(id) => {
                setStudioVersion({ id, nonce: Date.now() });
                setView("studio");
              }}
            />
          )}
          {view === "context" && patient && <Context data={data} patient={patient} clinician={isVerifiedClinician} busy={busy} run={run} />}
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

function PatientClinicianCollaborationPanel({
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
  const isOwnerPatient = Boolean(patient.is_self) && s(patient, "user_id") === data.profile.user_id;
  const consents = (data.clinicianConsents ?? []).filter((c) => c.patient_id === pid);
  const availableClinicians = (data.availableClinicians ?? []).filter(
    (c) => c.user_id !== data.profile.user_id,
  );
  const accessLogs = (data.consentAccessLogs ?? []).filter((l) => l.patient_id === pid);

  const [selectedClinicianId, setSelectedClinicianId] = useState<string>(
    availableClinicians[0]?.user_id ?? "",
  );
  const [selectedPerms, setSelectedPerms] = useState<string[]>([...DEFAULT_CLINICIAN_PERMISSIONS]);
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [scopeNote, setScopeNote] = useState<string>(
    "Authorized clinical consultation and longitudinal imaging review",
  );

  function togglePerm(perm: string) {
    setSelectedPerms((prev) =>
      prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm],
    );
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-line bg-paper p-4"
      data-testid="patient-clinician-collaboration"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl">Patient–Clinician Record Sharing & Granular Consent</h2>
          <p className="text-xs text-muted">
            Clinicians can access this medical record only when an active, non-expired authorization
            exists and their clinician credentials remain approved. Administrators do not
            automatically receive unrestricted access to patient medical records.
          </p>
        </div>
        <Chip tone="pine">{`${consents.filter((c) => c.status === "active").length} active clinician(s)`}</Chip>
      </div>

      {/* Currently Assigned / Historical Clinicians */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-ink">Assigned Clinicians & Consent Status</p>
        {consents.length === 0 ? (
          <p className="text-xs text-muted">
            No clinicians have been granted access to this record yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {consents.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-line bg-card p-3 space-y-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-ink">
                    {c.clinician_display_name || c.clinician_user_id}
                    {c.clinician_licence_no
                      ? ` · Licence ${c.clinician_licence_no} (${c.clinician_registry})`
                      : ""}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Chip
                      tone={
                        c.status === "active"
                          ? "pine"
                          : c.status === "revoked"
                            ? "clay"
                            : "ink"
                      }
                    >
                      {`consent: ${c.status}`}
                    </Chip>
                    {c.clinician_verification_status && (
                      <Chip
                        tone={
                          c.clinician_verification_status === "verified" ||
                          c.clinician_verification_status === "approved"
                            ? "pine"
                            : "clay"
                        }
                      >
                        {`credential: ${c.clinician_verification_status}`}
                      </Chip>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {c.permissions.map((perm) => (
                    <Chip key={perm}>{perm.replaceAll("_", " ")}</Chip>
                  ))}
                </div>
                <p className="text-xs text-muted">
                  Granted: {new Date(c.granted_at).toLocaleString()}
                  {c.expires_at ? ` · Expires: ${new Date(c.expires_at).toLocaleString()}` : " · No automatic expiry"}
                  {c.revoked_at ? ` · Revoked: ${new Date(c.revoked_at).toLocaleString()} (${c.revoked_reason ?? ""})` : ""}
                </p>
                {c.status === "active" &&
                  (isOwnerPatient || c.clinician_user_id === data.profile.user_id) && (
                    <div className="pt-1">
                      <Button
                        tone="clay"
                        disabled={busy}
                        onClick={() => {
                          void run(() =>
                            revokePatientConsent({
                              data: {
                                consentId: c.id,
                                reason: isOwnerPatient
                                  ? "Revoked by patient in Collaboration panel"
                                  : "Relinquished by assigned clinician",
                              },
                            }),
                          );
                        }}
                      >
                        Revoke Access Immediately
                      </Button>
                    </div>
                  )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Grant Consent Form (Patient Owner Only) */}
      {isOwnerPatient && (
        <form
          className="space-y-3 border-t border-line pt-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!selectedClinicianId.trim()) return;
            void run(() =>
              grantPatientConsent({
                data: {
                  patientId: pid,
                  clinicianUserId: selectedClinicianId.trim(),
                  permissions: selectedPerms,
                  scopeNote,
                  expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                },
              }),
            );
          }}
        >
          <p className="text-xs font-medium text-ink">
            Grant Record Access to an Approved Clinician
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-muted">
              Approved Clinician
              <select
                className="mt-1 min-h-10 w-full rounded-md border border-line bg-card px-2 text-sm text-ink"
                value={selectedClinicianId}
                onChange={(e) => setSelectedClinicianId(e.target.value)}
              >
                <option value="">Select approved clinician…</option>
                {availableClinicians.map((cl) => (
                  <option key={cl.user_id} value={cl.user_id}>
                    {`${cl.display_name} · ${cl.licence_no} (${cl.registry})`}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-muted">
              Optional Expiry Date
              <input
                type="date"
                className="mt-1 min-h-10 w-full rounded-md border border-line bg-card px-2 text-sm text-ink"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </label>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted">Granular Permissions Scope</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 text-xs">
              {ALL_CLINICIAN_PERMISSIONS.map((perm) => (
                <label
                  key={perm}
                  className="flex items-center gap-1.5 rounded border border-line bg-card px-2 py-1.5 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedPerms.includes(perm)}
                    onChange={() => togglePerm(perm)}
                  />
                  <span>{perm.replaceAll("_", " ")}</span>
                </label>
              ))}
            </div>
          </div>
          <input
            className="min-h-10 w-full rounded-md border border-line bg-card px-2 text-sm text-ink"
            placeholder="Purpose / clinical scope note"
            value={scopeNote}
            onChange={(e) => setScopeNote(e.target.value)}
          />
          <Button
            type="submit"
            disabled={busy || !selectedClinicianId.trim() || selectedPerms.length === 0}
          >
            Grant Clinician Access
          </Button>
        </form>
      )}

      {/* Consent Access Audit History */}
      {accessLogs.length > 0 && (
        <div className="space-y-1 border-t border-line pt-2 text-xs text-muted">
          <p className="font-medium text-ink">Consent & Access Audit Trail (Append-Only)</p>
          <ul className="max-h-32 overflow-auto space-y-1">
            {accessLogs.slice(0, 12).map((log) => (
              <li key={log.id}>
                {new Date(log.created_at).toLocaleString()} · [{log.outcome.toUpperCase()}]{" "}
                {log.action} ({log.actor_user_id}) — {log.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function People({
  data,
  patients,
  active,
  busy,
  run,
  onOpen,
}: {
  data: Workspace;
  patients: Bag[];
  active: Bag;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  onOpen: (id: string) => void;
}) {
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
      <article className="space-y-4 rounded-lg border border-line bg-card p-4">
        <h1 className="text-3xl">{s(active, "display_name")}</h1>
        <p className="text-sm text-ink-soft">{s(active, "synopsis")}</p>
        <p className="text-sm text-muted">Year of birth on the synthetic file: {s(active, "year_of_birth")}. Pathway: {s(active, "pathway")}.</p>
        <PatientClinicianCollaborationPanel data={data} patient={active} busy={busy} run={run} />
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
  focusVersion,
  onOpenReport,
  onOpenSlice,
}: {
  data: Workspace;
  patient: Bag;
  clinician: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  focusVersion?: { id: string; nonce: number } | null;
  onOpenReport?: (reportId: string, start: number | null, end: number | null) => void;
  onOpenSlice?: (versionId: string, studyId: string, seriesId: string, slice: number | null, demoExamKey: string | null) => void;
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

  useEffect(() => {
    if (!focusVersion) return;
    const v = versions.find((x) => s(x, "id") === focusVersion.id);
    if (!v) return;
    setStudyId(s(v, "study_id"));
    setSelected(focusVersion.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusVersion?.nonce]);

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

  const trendHistory: FindingHistoryPoint[] = useMemo(() => {
    return history.map((v) => {
      const ax = triple(v, "axes_mm");
      const vol = ax
        ? Math.round((Math.PI / 6) * ax[0] * ax[1] * ax[2])
        : (num(v, "longest_mm") ? Math.round((Math.PI / 6) * Math.pow(num(v, "longest_mm")!, 3)) : 1000);
      return {
        id: s(v, "id"),
        date: s(v, "observed_on") || "2026-01-01",
        label: s(v, "location_label") || `v${s(v, "version_no")}`,
        volumeMm3: vol,
        longestMm: num(v, "longest_mm"),
        modality: s(v, "modality") || "MR",
      };
    });
  }, [history]);

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
      {chosen && (
        <EvidenceTrail
          data={data}
          versionId={s(chosen, "id")}
          onOpenReport={(reportId, start, end) => onOpenReport?.(reportId, start, end)}
          onOpenSlice={(...a) => onOpenSlice?.(...a)}
        />
      )}
      {chosen && (
        <>
          <EvidenceSummaryPanel data={data} versionId={s(chosen, "id")} />
          <FindingHistory data={data} findingId={s(chosen, "finding_id")} />
        </>
      )}
      {chosen && trendHistory.length > 0 && (
        <div className="mt-6">
          <LongitudinalTrends
            patientName={s(patient, "name") || "Patient"}
            history={trendHistory}
            discrepancies={comparisons.map((c) => ({
              id: c.id,
              category: LABELS[c.gap.category] ?? c.gap.category,
              summary: `${c.code}: ${c.gap.detail}`,
              detail: c.gap.detail,
            }))}
          />
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

/** Legacy ReproTrace list, superseded by TraceReview (kept for reference). */
export function LegacyTrace({
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
              <p className="text-xs tabular-nums text-muted">
                Score {num(row, "score") ?? "—"} · {s(row, "engine_version")}
                {s(row, "registration_status") ? ` · Reg: ${s(row, "registration_status")}` : ""}
                {num(row, "registration_ncc") != null ? ` (NCC ${Number(num(row, "registration_ncc")).toFixed(2)})` : ""}
                {num(row, "registration_residual_mm") != null ? ` · Residual ${Number(num(row, "registration_residual_mm")).toFixed(1)} mm` : ""}
              </p>
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
  clinician,
}: {
  data: Workspace;
  patient: Bag;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  clinician?: boolean;
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
      <PatientTimeline data={data} patientId={pid} />
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
      <section className="rounded-lg border border-line bg-paper p-3 text-xs text-ink-soft" data-testid="evidence-provenance-tiers">
        <span className="font-semibold text-ink">6-Tier Evidence & Provenance Model: </span>
        <Chip>1. Patient-reported</Chip>{" "}
        <Chip>2. Original imaging observation</Chip>{" "}
        <Chip>3. Report-extracted</Chip>{" "}
        <Chip tone="clay">4. AI experimental (unconfirmed)</Chip>{" "}
        <Chip tone="pine">5. Clinician-reviewed</Chip>{" "}
        <Chip tone="pine">6. Confirmed clinical assessment</Chip>
        <span className="ml-2 text-muted">
          AI outputs never overwrite source evidence. Only verified clinicians can approve clinical findings.
        </span>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <FibroidPathwaySection pid={pid} data={data} clinician={clinician} busy={busy} run={run} />
        <EndometriosisSection pid={pid} data={data} clinician={clinician} busy={busy} run={run} />
        <OvarianCystSection pid={pid} data={data} clinician={clinician} busy={busy} run={run} />
        <PcosAssessmentSection pid={pid} data={data} clinician={clinician} busy={busy} run={run} />
      </div>
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
        <h1 className="text-3xl">Models, verification, audit, export</h1>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {(data.models as { id: string; name: string; status: string; note: string }[]).map((model) => (
          <article key={model.id} className="rounded-lg border border-line bg-card p-4">
            <div className="flex flex-wrap gap-2">
              <h2 className="text-lg">{model.name}</h2>
              <Chip tone={model.status === "not_connected" ? "clay" : "pine"}>{model.status.replaceAll("_", " ")}</Chip>
            </div>
            <p className="mt-2 text-sm text-ink-soft">{model.note}</p>
          </article>
        ))}
      </div>

      {role === "admin" && (
        <section className="space-y-3 rounded-lg border border-line bg-card p-4" data-testid="admin-verifications">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Clinician Verification Requests</h2>
            <Chip tone="pine">{`${(data.verifications ?? []).filter((v) => v.status === "pending").length} pending`}</Chip>
          </div>
          <p className="text-sm text-ink-soft">
            Review submitted medical licenses and practice credentials. Approving promotes the account to verified clinician status; revoking removes clinical capabilities.
          </p>
          {(!data.verifications || data.verifications.length === 0) ? (
            <p className="text-sm text-muted">No verification requests submitted.</p>
          ) : (
            <div className="space-y-3">
              {data.verifications.map((v) => (
                <div key={v.id} className="rounded-md border border-line bg-paper p-3 text-sm space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-ink">
                      {v.display_name || v.user_id} · <span className="font-normal text-ink-soft">Licence: {v.licence_no} ({v.registry})</span>
                    </span>
                    <Chip tone={v.status === "verified" || v.status === "approved" ? "pine" : v.status === "pending" ? "clay" : "ink"}>
                      {v.status}
                    </Chip>
                  </div>
                  {v.evidence_note && <p className="text-xs text-ink-soft">Note: {v.evidence_note}</p>}
                  {v.reason && <p className="text-xs text-muted">Decision note: {v.reason}</p>}
                  <p className="text-xs text-muted">Requested: {new Date(v.requested_at).toLocaleString()}</p>
                  {v.status === "pending" && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        tone="pine"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Reason for verification approval:", "Medical license and registration verified");
                          if (reason) {
                            void run(() => verifyClinician({ data: { verificationId: v.id, decision: "verified", reason } }));
                          }
                        }}
                      >
                        Approve verification
                      </Button>
                      <Button
                        tone="clay"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Reason for rejecting verification:", "Credential requirements not met");
                          if (reason) {
                            void run(() => verifyClinician({ data: { verificationId: v.id, decision: "rejected", reason } }));
                          }
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                  {(v.status === "verified" || v.status === "approved") && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        tone="ghost"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Reason for suspending clinician verification:", "Pending credential re-verification");
                          if (reason) {
                            void run(() => verifyClinician({ data: { verificationId: v.id, decision: "suspended", reason } }));
                          }
                        }}
                      >
                        Suspend
                      </Button>
                      <Button
                        tone="clay"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Reason for revoking clinician verification:", "Annual audit / credential expiration");
                          if (reason) {
                            void run(() => verifyClinician({ data: { verificationId: v.id, decision: "revoked", reason } }));
                          }
                        }}
                      >
                        Revoke credentials
                      </Button>
                    </div>
                  )}
                  {v.status === "suspended" && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        tone="pine"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Reason for reinstating clinician verification:", "Credentials re-verified");
                          if (reason) {
                            void run(() => verifyClinician({ data: { verificationId: v.id, decision: "verified", reason } }));
                          }
                        }}
                      >
                        Approve verification
                      </Button>
                      <Button
                        tone="clay"
                        disabled={busy}
                        onClick={() => {
                          const reason = window.prompt("Reason for revoking clinician verification:", "Credential revocation confirmed");
                          if (reason) {
                            void run(() => verifyClinician({ data: { verificationId: v.id, decision: "revoked", reason } }));
                          }
                        }}
                      >
                        Revoke credentials
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {role === "admin" && (
        <section className="space-y-3 rounded-lg border border-line bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl">Clinician Logins & Demo Accounts</h2>
            <Chip tone="pine">Provisioning</Chip>
          </div>
          <p className="text-sm text-ink-soft">
            Pre-configured credentials and instant-provisioning for clinical review and Volume Lab demonstration.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2 rounded-md border border-line bg-paper p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">Dr. Sarah Chen, MD</span>
                <Chip tone="pine">Verified Clinician</Chip>
              </div>
              <p className="text-xs text-ink-soft">Consultant Gynecologist · GMC-7489201 (UK)</p>
              <div className="rounded bg-card p-2 text-xs text-muted">
                <p>Email: <code className="font-mono text-pine">dr.chen@reprocare.health</code></p>
                <p>Password: <code className="font-mono text-pine">Clinician123!</code></p>
              </div>
              <p className="text-xs text-muted">Full access to Volume Lab, 3D segmentation, and longitudinal review.</p>
            </div>
            <div className="space-y-2 rounded-md border border-line bg-paper p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">Dr. Ananya Rao, MD</span>
                <Chip tone="pine">Verified Clinician</Chip>
              </div>
              <p className="text-xs text-ink-soft">Reproductive Endocrinologist · NMC-2018-84729</p>
              <div className="rounded bg-card p-2 text-xs text-muted">
                <p>Email: <code className="font-mono text-pine">clinician@reprocare.health</code></p>
                <p>Password: <code className="font-mono text-pine">Clinician123!</code></p>
              </div>
              <p className="text-xs text-muted">Full access to multi-series DICOM registration and PCOS diagnostic engine.</p>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-3 rounded-lg border border-line bg-card p-4" data-testid="clinician-verification-panel">
        <h2 className="text-xl">Clinician Credentialing</h2>
        <p className="text-sm text-ink-soft">
          Medical professionals must submit valid regulatory registration before clinical measurement tools (e.g. Volume Lab, AI confirmation, finding recording) can be used.
        </p>
        <ClinicianVerificationForm busy={busy} run={run} verifications={data.verifications ?? []} currentUserId={data.profile.user_id} />
      </section>

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

function ClinicianVerificationForm({
  busy,
  run,
  verifications,
  currentUserId,
}: {
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
  verifications: Bag[];
  currentUserId: string;
}) {
  const [licenceNo, setLicenceNo] = useState("");
  const [registry, setRegistry] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const myVerifications = verifications.filter((v) => s(v, "user_id") === currentUserId);
  const latest = myVerifications[0];

  return (
    <div className="space-y-3">
      {latest && (
        <div className="rounded-md bg-paper p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-ink">Credential status: {s(latest, "status").toUpperCase()}</span>
            <Chip tone={s(latest, "status") === "verified" || s(latest, "status") === "approved" ? "pine" : s(latest, "status") === "pending" ? "clay" : "ink"}>
              {s(latest, "status")}
            </Chip>
          </div>
          <p className="mt-1 text-xs text-muted">
            Licence: {s(latest, "licence_no")} ({s(latest, "registry")}) · Submitted: {new Date(s(latest, "requested_at")).toLocaleDateString()}
          </p>
          {s(latest, "reason") && <p className="text-xs text-ink-soft mt-1">Review note: {s(latest, "reason")}</p>}
        </div>
      )}
      {(!latest || ["revoked", "rejected", "suspended"].includes(s(latest, "status"))) && (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!licenceNo.trim() || !registry.trim()) return;
            void run(async () => {
              await requestClinicianVerification({ data: { licenceNo: licenceNo.trim(), registry: registry.trim(), evidenceNote: evidenceNote.trim() } });
              setDone("Verification request submitted for administrator review.");
              setLicenceNo("");
              setRegistry("");
              setEvidenceNote("");
            });
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              data-testid="clinician-licence-input"
              className="min-h-11 rounded-md border border-line bg-paper px-2 text-sm text-ink"
              placeholder="Medical licence number (e.g. GMC 1234567)"
              value={licenceNo}
              onChange={(e) => setLicenceNo(e.target.value)}
              required
            />
            <input
              data-testid="clinician-registry-input"
              className="min-h-11 rounded-md border border-line bg-paper px-2 text-sm text-ink"
              placeholder="Medical registry / licensing body"
              value={registry}
              onChange={(e) => setRegistry(e.target.value)}
              required
            />
          </div>
          <textarea
            data-testid="clinician-note-input"
            className="min-h-20 rounded-md border border-line bg-paper p-2 text-sm text-ink"
            placeholder="Clinical specialty, hospital affiliation, or verification context"
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy || !licenceNo.trim() || !registry.trim()}>
              Submit for Verification
            </Button>
            {done && <span className="text-xs text-pine">{done}</span>}
          </div>
        </form>
      )}
    </div>
  );
}


function FibroidPathwaySection({
  pid,
  data,
  clinician,
  busy,
  run,
}: {
  pid: string;
  data: Workspace;
  clinician?: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const records = (data.fibroidAssessments ?? []).filter((r) => !r.patient_id || r.patient_id === pid);
  const findings = (data.findings as Bag[]).filter((f) => s(f, "patient_id") === pid && s(f, "structure") === "fibroid");
  const [location, setLocation] = useState("Anterior wall intramural");
  const [figo, setFigo] = useState("4");
  const [axesText, setAxesText] = useState("42, 37, 34");
  const [segSource, setSegSource] = useState("clinician_caliper");

  return (
    <section className="space-y-3 rounded-lg border border-line bg-card p-4" data-testid="fibroid-pathway-section">
      <div className="flex items-center justify-between">
        <h2 className="text-xl">Uterine Fibroid Pathway</h2>
        <Chip tone="pine">PALM-COEIN / FIGO</Chip>
      </div>
      <p className="text-xs text-muted">
        Integrates MRI/US measurements, 3D volume estimation, report findings, and clinician-reviewed FIGO classification. FIGO classifications are never invented; measurements remain unconfirmed until clinician review.
      </p>
      <ul className="space-y-2 text-sm">
        {records.map((rec) => (
          <li key={rec.id} className="rounded-md border border-line bg-paper p-2 space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
              <span className="font-medium text-ink">
                {rec.anatomical_location} · {rec.figo_classification ? `FIGO ${rec.figo_classification} (${rec.figo_source})` : "FIGO not assigned"}
              </span>
              <div className="flex gap-1">
                <Chip tone={rec.evidence_tier === "ai_experimental" ? "clay" : "ink"}>{rec.evidence_tier.replaceAll("_", " ")}</Chip>
                <Chip tone={rec.review_status === "clinician_confirmed_assessment" || rec.review_status === "clinician_reviewed" ? "pine" : "clay"}>
                  {rec.review_status.replaceAll("_", " ")}
                </Chip>
              </div>
            </div>
            <p className="text-xs text-ink-soft">
              Longest: {rec.longest_mm ?? "—"} mm · Volume: {rec.volume_mm3 ? `${(rec.volume_mm3 / 1000).toFixed(1)} mL (${rec.volume_mm3} mm³)` : "—"}
            </p>
            {rec.longitudinal_comparison_note && <p className="text-xs text-pine">{rec.longitudinal_comparison_note}</p>}
            {clinician && rec.review_status === "unreviewed" && (
              <div className="pt-1">
                <Button
                  tone="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      reviewPathwayRecord({
                        data: {
                          patientId: pid,
                          pathway: "fibroids",
                          recordId: rec.id,
                          decision: "clinician_confirmed_assessment",
                          note: "Clinician verified fibroid location, dimensions, and FIGO subclassification.",
                        },
                      }),
                    )
                  }
                >
                  Approve Fibroid Assessment
                </Button>
              </div>
            )}
          </li>
        ))}
        {records.length === 0 && (
          <li className="text-xs text-muted">
            {findings.length > 0
              ? `${findings.length} fibroid finding(s) tracked in Studio/ReproTrace. Record a structured pathway assessment below.`
              : "No structured uterine fibroid pathway assessments recorded for this patient."}
          </li>
        )}
      </ul>
      {clinician && (
        <form
          className="space-y-2 border-t border-line pt-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const parsedAxes = axesText
              .split(",")
              .map((x) => Number(x.trim()))
              .filter((n) => Number.isFinite(n) && n > 0);
            const axesMm =
              parsedAxes.length === 3
                ? ([parsedAxes[0], parsedAxes[1], parsedAxes[2]] as [number, number, number])
                : null;
            void run(() =>
              saveFibroidAssessment({
                data: {
                  patientId: pid,
                  findingId: findings[0] ? s(findings[0], "id") : null,
                  anatomicalLocation: location,
                  figoClassification: figo || null,
                  figoSource: figo ? "clinician_entered" : "not_assigned",
                  axesMm,
                  segmentationSource: segSource,
                },
              }),
            );
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-muted">
              Anatomical Location
              <input
                className="mt-1 min-h-10 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </label>
            <label className="block text-muted">
              FIGO Subclassification (optional)
              <select
                className="mt-1 min-h-10 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={figo}
                onChange={(e) => setFigo(e.target.value)}
              >
                <option value="">Not assigned</option>
                <option value="0">FIGO 0 (Pedunculated intracavitary)</option>
                <option value="1">FIGO 1 (Submucosal &lt;50% intramural)</option>
                <option value="2">FIGO 2 (Submucosal &gt;=50% intramural)</option>
                <option value="3">FIGO 3 (100% intramural, contacts endometrium)</option>
                <option value="4">FIGO 4 (Intramural)</option>
                <option value="5">FIGO 5 (Subserosal &gt;=50% intramural)</option>
                <option value="6">FIGO 6 (Subserosal &lt;50% intramural)</option>
                <option value="7">FIGO 7 (Pedunculated subserosal)</option>
                <option value="8">FIGO 8 (Other, e.g. cervical/parasitic)</option>
                <option value="2-5">FIGO 2-5 (Hybrid transmural)</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-muted">
              3-Axis Dimensions (mm)
              <input
                className="mt-1 min-h-10 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={axesText}
                onChange={(e) => setAxesText(e.target.value)}
              />
            </label>
            <label className="block text-muted">
              Measurement Source
              <select
                className="mt-1 min-h-10 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={segSource}
                onChange={(e) => setSegSource(e.target.value)}
              >
                <option value="clinician_caliper">Clinician 3-axis caliper</option>
                <option value="classical_region_growing">Seeded region growing</option>
                <option value="ai_unet3d">AI 3D UNet segmentation (experimental)</option>
              </select>
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            Save Fibroid Assessment
          </Button>
        </form>
      )}
    </section>
  );
}

function EndometriosisSection({
  pid,
  data,
  clinician,
  busy,
  run,
}: {
  pid: string;
  data: Workspace;
  clinician?: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const records = (data.endometriosisRecords ?? []).filter((r) => !r.patient_id || r.patient_id === pid);
  const [staging, setStaging] = useState("Stage II (Mild)");
  const [surgicalHistory, setSurgicalHistory] = useState("");
  const [imagingNote, setImagingNote] = useState("");
  const [siteText, setSiteText] = useState("Uterosacral ligaments, Pouch of Douglas");

  return (
    <section className="space-y-3 rounded-lg border border-line bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl">Endometriosis Records</h2>
        <Chip tone="clay">Clinical Decision Aid</Chip>
      </div>
      <p className="text-xs text-muted">
        rASRM / Enzian classification aid. Not an autonomous diagnostic device. A normal ultrasound or MRI examination NEVER excludes endometriosis, and symptoms alone do not localize lesions.
      </p>
      <ul className="space-y-2 text-sm">
        {records.map((rec) => (
          <li key={rec.id} className="rounded-md border border-line bg-paper p-2 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="font-medium text-ink">{rec.staging_rASRM || "Unstaged"}</span>
              <span className="text-muted">{new Date(rec.created_at).toLocaleDateString()}</span>
            </div>
            <p className="text-xs text-ink-soft">Sites: {rec.lesion_sites_json}</p>
            {rec.imaging_note && <p className="text-xs text-muted">Imaging: {rec.imaging_note}</p>}
            {rec.surgical_history && <p className="text-xs text-muted">Surgery: {rec.surgical_history}</p>}
          </li>
        ))}
        {records.length === 0 && <li className="text-xs text-muted">No structured endometriosis records stored for this patient.</li>}
      </ul>
      {clinician && (
        <form
          className="space-y-2 pt-2 border-t border-line"
          onSubmit={(e) => {
            e.preventDefault();
            const sites = siteText.split(",").map((s) => s.trim()).filter(Boolean);
            void run(() => saveEndometriosisRecord({
              data: {
                patientId: pid,
                lesionSites: sites,
                surgicalHistory: surgicalHistory.trim(),
                stagingRASRM: staging,
                imagingNote: imagingNote.trim(),
              },
            }));
            setImagingNote("");
            setSurgicalHistory("");
          }}
        >
          <label className="block text-xs text-muted">
            rASRM Staging
            <select className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" value={staging} onChange={(e) => setStaging(e.target.value)}>
              <option>Stage I (Minimal)</option>
              <option>Stage II (Mild)</option>
              <option>Stage III (Moderate)</option>
              <option>Stage IV (Severe)</option>
              <option>Extragenital / Deep Infiltrating (Enzian)</option>
            </select>
          </label>
          <label className="block text-xs text-muted">
            Suspected / confirmed lesion sites (comma-separated)
            <input className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" value={siteText} onChange={(e) => setSiteText(e.target.value)} />
          </label>
          <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" placeholder="Surgical / laparoscopy history" value={surgicalHistory} onChange={(e) => setSurgicalHistory(e.target.value)} />
          <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" placeholder="Imaging findings note (US / MRI)" value={imagingNote} onChange={(e) => setImagingNote(e.target.value)} />
          <Button type="submit" disabled={busy}>Save Endometriosis Record</Button>
        </form>
      )}
    </section>
  );
}

function OvarianCystSection({
  pid,
  data,
  clinician,
  busy,
  run,
}: {
  pid: string;
  data: Workspace;
  clinician?: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const records = (data.ovarianCystRecords ?? []).filter((r) => !r.patient_id || r.patient_id === pid);
  const [laterality, setLaterality] = useState<"left" | "right" | "bilateral">("left");
  const [maxDiameterMm, setMaxDiameterMm] = useState(38);
  const [featuresText, setFeaturesText] = useState("Simple anechoic, thin smooth walls, no internal vascularity (O-RADS 2)");
  const [followUpMonths, setFollowUpMonths] = useState(6);
  const [clinicalNote, setClinicalNote] = useState("");

  return (
    <section className="space-y-3 rounded-lg border border-line bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl">Ovarian Cyst Records</h2>
        <Chip tone="clay">O-RADS Framework</Chip>
      </div>
      <p className="text-xs text-muted">
        Ovarian risk stratification. Not an autonomous device. Sonographic follow-up guided by ACR O-RADS criteria.
      </p>
      <ul className="space-y-2 text-sm">
        {records.map((rec) => (
          <li key={rec.id} className="rounded-md border border-line bg-paper p-2 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="font-medium text-ink">{rec.laterality.toUpperCase()} · {rec.max_diameter_mm} mm</span>
              <span className="text-muted">{new Date(rec.created_at).toLocaleDateString()}</span>
            </div>
            <p className="text-xs text-ink-soft">Features: {rec.features_text}</p>
            {rec.follow_up_months && <p className="text-xs text-pine">Follow-up: {rec.follow_up_months} months</p>}
            {rec.clinical_note && <p className="text-xs text-muted">{rec.clinical_note}</p>}
          </li>
        ))}
        {records.length === 0 && <li className="text-xs text-muted">No ovarian cyst records stored for this patient.</li>}
      </ul>
      {clinician && (
        <form
          className="space-y-2 pt-2 border-t border-line"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => saveOvarianCystRecord({
              data: {
                patientId: pid,
                laterality,
                maxDiameterMm,
                featuresText: featuresText.trim(),
                followUpMonths,
                clinicalNote: clinicalNote.trim(),
              },
            }));
            setClinicalNote("");
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted">
              Laterality
              <select className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" value={laterality} onChange={(e) => setLaterality(e.target.value as "left" | "right" | "bilateral")}>
                <option value="left">Left ovary</option>
                <option value="right">Right ovary</option>
                <option value="bilateral">Bilateral</option>
              </select>
            </label>
            <label className="block text-xs text-muted">
              Max diameter (mm)
              <input type="number" min={1} max={300} className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" value={maxDiameterMm} onChange={(e) => setMaxDiameterMm(Number(e.target.value))} />
            </label>
          </div>
          <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" placeholder="Acoustic features / O-RADS score" value={featuresText} onChange={(e) => setFeaturesText(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-muted">
              Follow-up (months)
              <input type="number" min={0} max={36} className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" value={followUpMonths} onChange={(e) => setFollowUpMonths(Number(e.target.value))} />
            </label>
            <label className="block text-xs text-muted">
              Clinical note
              <input className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" placeholder="e.g. Asymptomatic, premenopausal" value={clinicalNote} onChange={(e) => setClinicalNote(e.target.value)} />
            </label>
          </div>
          <Button type="submit" disabled={busy}>Save Ovarian Cyst Record</Button>
        </form>
      )}
    </section>
  );
}

function PcosAssessmentSection({
  pid,
  data,
  clinician,
  busy,
  run,
}: {
  pid: string;
  data: Workspace;
  clinician?: boolean;
  busy: boolean;
  run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const records = (data.pcosAssessments ?? []).filter((r) => !r.patient_id || r.patient_id === pid);
  const [cycleIrreg, setCycleIrreg] = useState(true);
  const [hyperClin, setHyperClin] = useState(true);
  const [hyperBio, setHyperBio] = useState(false);
  const [pcom, setPcom] = useState(true);
  const [notes, setNotes] = useState("");

  const hyperPresent = hyperClin || hyperBio;
  const count = [cycleIrreg, hyperPresent, pcom].filter(Boolean).length;
  const criteriaMet = count >= 2;

  return (
    <section className="space-y-3 rounded-lg border border-line bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl">PCOS Evaluation</h2>
        <Chip tone={criteriaMet ? "pine" : "clay"}>{`Rotterdam: ${count}/3`}</Chip>
      </div>
      <p className="text-xs text-muted">
        2023 International Guideline / Rotterdam 2003 criteria. Diagnosis requires &gt;= 2 features and exclusion of mimickers.
      </p>
      <ul className="space-y-2 text-sm">
        {records.map((rec) => (
          <li key={rec.id} className="rounded-md border border-line bg-paper p-2 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="font-semibold text-ink">
                Rotterdam Criteria: {rec.rotterdam_criteria_met ? "MET (2 or more features)" : "NOT MET"}
              </span>
              <span className="text-muted">{new Date(rec.created_at).toLocaleDateString()}</span>
            </div>
            <p className="text-xs text-ink-soft">
              Cycle: {rec.cycle_irregularity ? "Yes" : "No"} · Hyperandrogenism: {rec.hyperandrogenism_clinical || rec.hyperandrogenism_biochemical ? "Yes" : "No"} · Morphology: {rec.ultrasound_or_amh_features ? "Yes" : "No"}
            </p>
            {rec.notes && <p className="text-xs text-muted">{rec.notes}</p>}
          </li>
        ))}
        {records.length === 0 && <li className="text-xs text-muted">No structured PCOS evaluations stored for this patient.</li>}
      </ul>
      {clinician && (
        <form
          className="space-y-2 pt-2 border-t border-line text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => savePcosAssessment({
              data: {
                patientId: pid,
                cycleIrregularity: cycleIrreg,
                hyperandrogenismClinical: hyperClin,
                hyperandrogenismBiochemical: hyperBio,
                ultrasoundOrAmhFeatures: pcom,
                notes: notes.trim(),
              },
            }));
            setNotes("");
          }}
        >
          <div className="space-y-1 rounded-md bg-paper p-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={cycleIrreg} onChange={(e) => setCycleIrreg(e.target.checked)} />
              <span>1. Ovulatory dysfunction (Oligo/amenorrhea)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={hyperClin} onChange={(e) => setHyperClin(e.target.checked)} />
              <span>2a. Clinical hyperandrogenism (Hirsutism/acne)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={hyperBio} onChange={(e) => setHyperBio(e.target.checked)} />
              <span>2b. Biochemical hyperandrogenism (Elevated testosterone/FAI)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={pcom} onChange={(e) => setPcom(e.target.checked)} />
              <span>3. Polycystic ovarian morphology (20+ follicles or vol 10+ mL, or high AMH)</span>
            </label>
          </div>
          <div className="rounded-md bg-paper p-2 font-medium">
            Status: {criteriaMet ? (
              <span className="text-pine">Criteria Met ({count}/3 features present)</span>
            ) : (
              <span className="text-clay">Criteria Not Met ({count}/3 features present)</span>
            )}
          </div>
          <input className="min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink" placeholder="Exclusion notes (TSH, prolactin, 17-OHP)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <Button type="submit" disabled={busy}>Save PCOS Assessment</Button>
        </form>
      )}
    </section>
  );
}
