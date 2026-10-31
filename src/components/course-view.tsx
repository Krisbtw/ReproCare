import type { Workspace } from "@/lib/clinic/types";

type Bag = Record<string, unknown>;

function s(row: object | undefined, key: string): string {
  if (!row) return "";
  const value = (row as Record<string, unknown>)[key];
  return value == null ? "" : String(value);
}

type Event = { date: string; kind: string; title: string; detail: string };

export function CourseView({
  data,
  patient,
  onStudio,
}: {
  data: Workspace;
  patient: Bag;
  onStudio: () => void;
}) {
  const pid = s(patient, "id");
  const events: Event[] = [];
  for (const study of data.studies) {
    if (study.patient_id !== pid) continue;
    events.push({
      date: study.study_date,
      kind: study.modality,
      title: `${study.modality} · ${study.description}`,
      detail: study.source_note,
    });
  }
  const findings = data.findings.filter((f) => f.patient_id === pid);
  for (const version of data.versions) {
    if (!findings.some((f) => f.id === version.finding_id)) continue;
    const finding = findings.find((f) => f.id === version.finding_id);
    events.push({
      date: version.observed_on,
      kind: "Finding",
      title: `${finding?.code ?? "Finding"} version ${version.version_no}`,
      detail: version.change_reason,
    });
  }
  for (const symptom of data.symptoms) {
    if (symptom.patient_id !== pid) continue;
    events.push({
      date: symptom.recorded_on,
      kind: "Symptom",
      title: `${symptom.region} · ${symptom.intensity}/10`,
      detail: `${symptom.description} Patient-reported. Not evidence that a nearby finding caused it.`,
    });
  }
  for (const cycle of data.cycles) {
    if (cycle.patient_id !== pid) continue;
    events.push({
      date: cycle.start_date,
      kind: "Cycle",
      title: cycle.length_days ? `${cycle.length_days}-day interval` : "Cycle start",
      detail: `${cycle.flow ?? ""} ${cycle.note}`.trim(),
    });
  }
  for (const lab of data.labs) {
    if (lab.patient_id !== pid) continue;
    events.push({
      date: lab.observed_on,
      kind: "Lab",
      title: `${lab.analyte} ${lab.value_text} ${lab.unit}`,
      detail: lab.source_note,
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-pine">Course · {s(patient, "display_name")}</p>
          <h1 className="text-3xl">What is on file, in order</h1>
          <p className="max-w-2xl text-sm text-ink-soft">
            Studies, finding versions, symptoms, cycles, and labs share one timeline. Order is not proof that one event caused another.
          </p>
        </div>
        <button type="button" onClick={onStudio} className="min-h-11 rounded-md bg-pine px-3 text-sm font-medium text-card">
          Open imaging studio
        </button>
      </header>
      {events.length === 0 ? (
        <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">Nothing is dated on this record yet.</p>
      ) : (
        <ol className="space-y-3">
          {events.map((event, index) => (
            <li key={`${event.date}-${event.kind}-${index}`} className="grid grid-cols-[0.5rem_1fr] gap-3">
              <span className="mt-2 size-2 rounded-full bg-pine" />
              <div>
                <p className="text-xs tabular-nums text-muted">
                  {event.date} · {event.kind}
                </p>
                <h2 className="text-lg">{event.title}</h2>
                <p className="text-sm text-ink-soft">{event.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
