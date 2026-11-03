import { DEMO_EXAMS, buildDemoSeriesFiles } from "@/lib/clinic/reprotrace-demo";
import { loadSourceSeries } from "@/lib/clinic/server";

export type SourceRequest = {
  nonce: number;
  slice: number | null;
  examKey?: string | null;
  patientId?: string | null;
  findingVersionId?: string | null;
  seriesId?: string | null;
};
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { loadDicomParser, type DataSetLike } from "@/lib/dicom/codec";
import { loadSeries, type LoadedSeries } from "@/lib/dicom/series-loader";
import { groupBySeries, type SeriesGroup } from "@/lib/dicom/series-groups";
import { buildSyntheticSeries } from "@/lib/dicom/series-writer";
import {
  autoWindow,
  buildProcessingRecord,
  clampIndex,
  histogram,
  maskCountsAlong,
  meshFromMask,
  voxelValue,
  type Axis,
  type DisplayWindow,
  type Histogram,
} from "@/lib/imaging/lab";
import { toBinaryStl, toObj, type MeshQuality } from "@/lib/imaging/mesh";
import type { Mesh } from "@/lib/imaging/isosurface";
import { measureMask, type MaskMeasurement } from "@/lib/imaging/metrics";
import { fnv1a, versionFromLab } from "@/lib/imaging/finding-link";
import { segmentFromSeed, windowFromSeed, type SegmentResult } from "@/lib/imaging/segment";
import type { Vec3, Volume } from "@/lib/imaging/volume";
import { checkHealth, compareReports, inspectWithService, serviceUrl, type CrossCheck, type ServiceSeriesReport } from "@/lib/imaging/service-client";
import {
  normalisePercentile,
  normaliseZScore,
  gaussianSmooth,
  medianFilter,
  qualityIndicators,
  type OpRecord,
} from "@/lib/imaging/preprocess";
import { transformMeshToPatient, imageMmToPatient } from "@/lib/imaging/patient-coords";
import { PlaneView } from "./plane-view";
import { VolumeStage, type VolumeStageHandle } from "./volume-stage";
import { ModelStatusPanel, type AiSegmentSuccess } from "./model-status-panel";

const MAX_FILES = 1500;
const MAX_TOTAL_BYTES = 1_000_000_000;
const MAX_FILE_BYTES = 64_000_000;

const PLANES: { axis: Axis; label: string; hint: string }[] = [
  { axis: 2, label: "Acquired plane", hint: "The plane the scanner saved, one image per slice." },
  { axis: 1, label: "Reformat · rows", hint: "The stack cut along its rows. Thick slices look blocky; nothing is interpolated." },
  { axis: 0, label: "Reformat · columns", hint: "The stack cut along its columns. Thick slices look blocky; nothing is interpolated." },
];

type Source = "sample" | "upload";
type Opened = { series: LoadedSeries; volume: Volume; source: Source; unreadable: number };
type Pending = { groups: SeriesGroup[]; unreadable: number; source: Source; parse: (b: Uint8Array) => DataSetLike };
type Seg = {
  result: SegmentResult;
  measurement: MaskMeasurement;
  mesh: { mesh: Mesh; quality: MeshQuality; blurIterations: number; taubinIterations: number } | null;
  seed: Vec3;
  seedValue: number | null;
  smooth: number;
  at: Date;
  aiModel?: AiSegmentSuccess["model"];
};
type FindingChoice = { id: string; label: string };
export type RecordFindingInput = {
  findingId: string;
  axes: [number, number, number];
  longest: number;
  sliceIndex: number;
  reason: string;
  evidenceNote: string;
  studyId?: string | null;
  seriesId?: string | null;
  centroidMm?: [number, number, number] | null;
  frame?: string | null;
  modelId?: string | null;
  segmentationSource?: string | null;
  segmentationRunId?: string | null;
  volumeMm3?: number | null;
  uncertaintyMm3?: number | null;
  sourceDicomFiles?: Array<{
    fileName?: string;
    sopInstanceUid?: string;
    instanceNumber?: number;
    dataBase64: string;
    metadata?: Record<string, unknown>;
  }>;
  maskArtifact?: {
    fileName?: string;
    dataBase64: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  };
  newStudy?: {
    patientId: string;
    modality?: string;
    studyDate?: string;
    description?: string;
    accession?: string;
    sourceNote?: string;
  };
  newSeries?: {
    seriesNumber?: number;
    description?: string;
    plane?: string;
    sliceCount?: number;
    pixelSpacingMm?: string;
    sliceThicknessMm?: number;
  };
};
type Params = { mode: "auto" | "manual"; k: number; radius: number; close: number; lower: string; upper: string; smooth: number };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** Optional Python imaging service. Unset = the cross-check card explains how to enable it and sends nothing. */
const SERVICE_BASE = serviceUrl((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_IMAGING_SERVICE_URL);

type CrossState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; service: ServiceSeriesReport; check: CrossCheck; at: Date; modelConnected: boolean | null }
  | { phase: "failed"; error: string };
const same = (a: Vec3 | null, b: Vec3 | null) => (a && b ? a[0] === b[0] && a[1] === b[1] && a[2] === b[2] : a === b);
const fmt = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? "n/a" : n.toFixed(digits));

function Card({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`space-y-3 rounded-lg border border-line bg-card p-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Tag({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "pine" | "clay" }) {
  const cls = tone === "pine" ? "bg-pine-soft text-pine" : tone === "clay" ? "bg-clay-soft text-clay" : "bg-paper text-ink-soft";
  return <span className={`inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium ${cls}`}>{children}</span>;
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
  const cls = tone === "ghost" ? "border border-line bg-card text-ink" : tone === "clay" ? "bg-clay text-card" : "bg-pine text-card";
  return (
    <button type="button" data-testid={testId} disabled={disabled} onClick={onClick} className={`min-h-11 rounded-md px-3 text-sm font-medium ${cls} disabled:opacity-50`}>
      {children}
    </button>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md bg-paper p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg tabular-nums text-ink">{value}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}

/** Reads a dropped item list, descending into folders. Items are read synchronously first: the browser clears them after the first await. */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

/** Slice ids become map keys downstream, so two files with the same name must not collide. */
function uniqueName(name: string, seen: Map<string, number>): string {
  const n = (seen.get(name) ?? 0) + 1;
  seen.set(name, n);
  return n === 1 ? name : `${name} (#${n})`;
}

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function HistogramBars({
  hist,
  display,
  segWindow,
  seedValue,
}: {
  hist: Histogram;
  display: DisplayWindow;
  segWindow: { lower: number; upper: number } | null;
  seedValue: number | null;
}) {
  const max = Math.max(1, ...hist.counts.map((c) => Math.log1p(c)));
  const x = (v: number) => Math.min(1, Math.max(0, (v - hist.lo) / (hist.hi - hist.lo))) * 100;
  const dl = x(display.center - display.width / 2);
  const dr = x(display.center + display.width / 2);
  return (
    <figure className="space-y-1">
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-24 w-full rounded-md bg-paper" role="img" aria-label="Intensity histogram, log scale, with the display window and the segmentation window">
        <rect x={dl} y={0} width={Math.max(0.3, dr - dl)} height={32} fill="#8d8376" opacity={0.18} />
        {hist.counts.map((c, i) => {
          const h = (Math.log1p(c) / max) * 30;
          return <rect key={i} x={(i / hist.counts.length) * 100} y={32 - h} width={100 / hist.counts.length - 0.15} height={h} fill="#3d4856" />;
        })}
        {segWindow && (
          <rect x={x(segWindow.lower)} y={0} width={Math.max(0.4, x(segWindow.upper) - x(segWindow.lower))} height={32} fill="#9a4634" opacity={0.28} />
        )}
        {seedValue != null && <line x1={x(seedValue)} x2={x(seedValue)} y1={0} y2={32} stroke="#9a4634" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption className="text-xs text-muted">
        Voxel intensities, log scale. Grey band: what the viewer shows. Clay band: what the segmentation will accept. Line: the seed.
      </figcaption>
    </figure>
  );
}

export function VolumeLab({
  findings = [],
  patientId,
  onRecord,
  recordFinding,
  openDemo,
  onOpenEvidence,
}: {
  /**
   * Request (from an evidence trail) to open a finding's source series at its anchored slice. Stored
   * DICOM instances are retrieved first; examKey enables a labelled synthetic-demo regeneration fallback.
   */
  openDemo?: SourceRequest | null;
  /** Back-navigation from the opened source image to the finding evidence trail (report quote, provenance). */
  onOpenEvidence?: (findingVersionId: string) => void;
  findings?: FindingChoice[];
  patientId?: string;
  onRecord?: (task: () => Promise<unknown>) => Promise<void>;
  recordFinding?: (input: RecordFindingInput) => Promise<unknown>;
}) {
  const [sourceNote, setSourceNote] = useState<{ origin: "stored" | "regenerated" | "unavailable"; text: string } | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // A refused series still shows its report, so the person can see what to fix.
  const [reportOnly, setReportOnly] = useState<{ series: LoadedSeries; source: Source; unreadable: number } | null>(null);
  const [pick, setPick] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [axis, setAxis] = useState<Axis>(2);
  const [cursor, setCursor] = useState<Vec3>([0, 0, 0]);
  const [seed, setSeed] = useState<Vec3 | null>(null);
  const [win, setWin] = useState<DisplayWindow>({ center: 0, width: 1 });
  const [hist, setHist] = useState<Histogram | null>(null);
  const [showMask, setShowMask] = useState(true);
  const [maskAlpha, setMaskAlpha] = useState(0.45);
  const [params, setParams] = useState<Params>({ mode: "auto", k: 2.5, radius: 2, close: 1, lower: "", upper: "", smooth: 10 });
  const [seg, setSeg] = useState<Seg | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [recFinding, setRecFinding] = useState("");
  const [recReason, setRecReason] = useState("");
  const [recDone, setRecDone] = useState<string | null>(null);
  const [recClinicianConfirmed, setRecClinicianConfirmed] = useState(false);
  // Files of the series currently shown, kept only in memory so they can be sent for the optional second check.
  const [seriesFiles, setSeriesFiles] = useState<{ name: string; bytes: Uint8Array }[]>([]);
  const [cross, setCross] = useState<CrossState>({ phase: "idle" });

  const [rawVolume, setRawVolume] = useState<Volume | null>(null);
  const [preprocessHistory, setPreprocessHistory] = useState<OpRecord[]>([]);
  const [gaussSigma, setGaussSigma] = useState(1.0);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const stage = useRef<VolumeStageHandle>(null);

  useEffect(() => {
    // Folder selection is not in React's input typings.
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  const volume = opened?.volume ?? null;
  const busy = status !== null;

  function resetWork() {
    setSeed(null);
    setSeg(null);
    setAxis(2);
    setShowSteps(false);
  }

  function applyGaussian() {
    if (!volume || !opened) return;
    setStatus("Applying Gaussian smoothing…");
    void (async () => {
      await tick();
      try {
        const res = gaussianSmooth(volume, gaussSigma);
        setOpened((o) => (o ? { ...o, volume: res.volume } : null));
        setPreprocessHistory((prev) => [...prev, res.record]);
        setHist(histogram(res.volume));
        resetWork();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Gaussian filter failed.");
      } finally {
        setStatus(null);
      }
    })();
  }

  function applyMedian() {
    if (!volume || !opened) return;
    setStatus("Applying 3×3×3 median filter…");
    void (async () => {
      await tick();
      try {
        const res = medianFilter(volume);
        setOpened((o) => (o ? { ...o, volume: res.volume } : null));
        setPreprocessHistory((prev) => [...prev, res.record]);
        setHist(histogram(res.volume));
        resetWork();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Median filter failed.");
      } finally {
        setStatus(null);
      }
    })();
  }

  function applyPercentile() {
    if (!volume || !opened) return;
    setStatus("Normalizing percentiles (0.5%–99.5%)…");
    void (async () => {
      await tick();
      try {
        const res = normalisePercentile(volume, 0.5, 99.5);
        setOpened((o) => (o ? { ...o, volume: res.volume } : null));
        setPreprocessHistory((prev) => [...prev, res.record]);
        setHist(histogram(res.volume));
        const w = autoWindow(res.volume);
        setWin({ center: w.center, width: w.width });
        resetWork();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Percentile normalization failed.");
      } finally {
        setStatus(null);
      }
    })();
  }

  function applyZScore() {
    if (!volume || !opened) return;
    setStatus("Normalizing Z-scores…");
    void (async () => {
      await tick();
      try {
        const res = normaliseZScore(volume);
        setOpened((o) => (o ? { ...o, volume: res.volume } : null));
        setPreprocessHistory((prev) => [...prev, res.record]);
        setHist(histogram(res.volume));
        const w = autoWindow(res.volume);
        setWin({ center: w.center, width: w.width });
        resetWork();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Z-score normalization failed.");
      } finally {
        setStatus(null);
      }
    })();
  }

  function revertPreprocessing() {
    if (!rawVolume || !opened) return;
    setOpened((o) => (o ? { ...o, volume: rawVolume } : null));
    setPreprocessHistory([]);
    setHist(histogram(rawVolume));
    const w = autoWindow(rawVolume);
    setWin({ center: w.center, width: w.width });
    resetWork();
  }

  const quality = useMemo(() => (volume ? qualityIndicators(volume) : null), [volume]);

  async function open(group: SeriesGroup, parse: (b: Uint8Array) => DataSetLike, source: Source, unreadable: number) {
    setStatus("Checking geometry and stacking the volume…");
    setError(null);
    await tick();
    try {
      const series = loadSeries(group.files, parse);
      resetWork();
      setSeriesFiles(group.files);
      setCross({ phase: "idle" });
      if (series.volume) {
        const v = series.volume;
        setRawVolume(v);
        setPreprocessHistory([]);
        const w = autoWindow(v);
        setWin({ center: w.center, width: w.width });
        setHist(histogram(v));
        setCursor([Math.floor(v.dims[0] / 2), Math.floor(v.dims[1] / 2), Math.floor(v.dims[2] / 2)]);
        setOpened({ series, volume: v, source, unreadable });
        setReportOnly(null);
      } else {
        setOpened(null);
        setHist(null);
        setError("This series could not be stacked into a volume. The checks below say why; nothing was repaired or guessed.");
        setReportOnly({ series, source, unreadable });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The series could not be loaded.");
    } finally {
      setStatus(null);
    }
  }

  async function ingest(files: { name: string; bytes: Uint8Array }[], source: Source) {
    setPending(null);
    setReportOnly(null);
    setError(null);
    setStatus("Reading headers…");
    await tick();
    try {
      const parse = await loadDicomParser();
      const grouped = groupBySeries(files, parse);
      if (grouped.groups.length === 0) {
        const why = grouped.unreadable[0]?.reason;
        setError(`No DICOM images were found among ${files.length} file${files.length === 1 ? "" : "s"}${why ? ` (first problem: ${why})` : ""}.`);
        setStatus(null);
        return;
      }
      if (grouped.groups.length === 1) {
        await open(grouped.groups[0], parse, source, grouped.unreadable.length);
      } else {
        setPending({ groups: grouped.groups, unreadable: grouped.unreadable.length, source, parse });
        setPick(grouped.groups[0].uid);
        setStatus(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The files could not be read.");
      setStatus(null);
    }
  }

  async function readFiles(list: File[]) {
    const real = list.filter((f) => !f.name.startsWith("."));
    if (real.length === 0) {
      setError("No files were selected.");
      return;
    }
    if (real.length > MAX_FILES) {
      setError(`${real.length} files is more than this screen loads at once (${MAX_FILES}). Choose a single series folder.`);
      return;
    }
    const total = real.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      setError(`${(total / 1e6).toFixed(0)} MB is more than can be held in the browser here (${MAX_TOTAL_BYTES / 1e6} MB). Choose a single series.`);
      return;
    }
    setError(null);
    const seen = new Map<string, number>();
    const items: { name: string; bytes: Uint8Array }[] = [];
    let skippedLarge = 0;
    for (let i = 0; i < real.length; i += 1) {
      const f = real[i];
      if (i % 20 === 0) {
        setStatus(`Reading files… ${i} of ${real.length}`);
        await tick();
      }
      if (f.size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      items.push({ name: uniqueName(path, seen), bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    await ingest(items, "upload");
    if (skippedLarge > 0) setError((prev) => prev ?? `${skippedLarge} file${skippedLarge === 1 ? " was" : "s were"} larger than ${MAX_FILE_BYTES / 1e6} MB and were not read.`);
  }

  useEffect(() => {
    if (!openDemo) return;
    void (async () => {
      setSourceNote(null);
      // 1. Original stored DICOM instances through the authorized, SHA-256-verified storage path.
      if (openDemo.patientId && (openDemo.findingVersionId || openDemo.seriesId)) {
        setStatus("Retrieving the original DICOM instances from imaging storage…");
        await tick();
        try {
          const r = await loadSourceSeries({
            data: { patientId: openDemo.patientId, findingVersionId: openDemo.findingVersionId ?? null, seriesId: openDemo.seriesId ?? null },
          });
          if (r.available) {
            const items = r.files.map((f) => {
              const bin = atob(f.base64);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
              return { name: f.name, bytes };
            });
            await ingest(items, "upload");
            const slice = r.sliceIndex ?? openDemo.slice;
            if (slice != null) setCursor((c) => [c[0], c[1], slice]);
            setSourceNote({
              origin: "stored",
              text: `Original stored DICOM: ${r.integrity.verified} instance(s), SHA-256 verified${r.integrity.failed ? `, ${r.integrity.failed} failed` : ""}. Anchored slice ${slice ?? "not recorded"}${r.sopInstanceUid ? ` · SOP …${r.sopInstanceUid.slice(-10)}` : ""}${r.frameNumber != null ? ` · frame ${r.frameNumber}` : ""}. Finding position: ${r.centroidLps ? `[${r.centroidLps.map((x) => x.toFixed(1)).join(", ")}] mm (${r.coordinateFrame ?? "frame?"})` : "no patient-space coordinate stored"}.`,
            });
            return;
          }
          if (!openDemo.examKey) {
            setStatus(null);
            setSourceNote({ origin: "unavailable", text: `Source image unavailable: ${r.reason ?? "no stored instances"}` });
            return;
          }
          setSourceNote({ origin: "regenerated", text: `Stored instances unavailable (${r.reason}). Showing the SYNTHETIC series regenerated from its generator parameters instead.` });
        } catch (e) {
          if (!openDemo.examKey) {
            setStatus(null);
            setSourceNote({ origin: "unavailable", text: `Source image could not be retrieved: ${e instanceof Error ? e.message : "error"}` });
            return;
          }
        }
      }
      // 2. Synthetic demo fallback: deterministic regeneration, labelled as such.
      const exam = DEMO_EXAMS.find((e) => e.key === openDemo.examKey);
      if (!exam) return;
      setStatus("Regenerating the synthetic demo series…");
      await tick();
      await ingest(buildDemoSeriesFiles(exam), "sample");
      if (openDemo.slice != null) setCursor((c) => [c[0], c[1], openDemo.slice as number]);
      setSourceNote((n) => n ?? { origin: "regenerated", text: "SYNTHETIC series regenerated from generator parameters." });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDemo?.nonce]);

  async function loadSample() {
    setStatus("Building the synthetic sample…");
    await tick();
    const files = buildSyntheticSeries({
      cols: 96,
      rows: 96,
      slices: 28,
      pixelSpacingMm: [1.2, 1.2],
      sliceStepMm: 4,
      lesionRadiiMm: [20, 16, 28],
      noise: 14,
      description: "SYNTHETIC sample (ellipsoid on flat background)",
    });
    await ingest(files, "sample");
  }

  function placeSeed(v: Vec3) {
    setSeed(v);
    setCursor(v);
  }

  function step(delta: number) {
    if (!volume) return;
    setCursor((c) => {
      const next: Vec3 = [c[0], c[1], c[2]];
      next[axis] = clampIndex(volume.dims, axis, c[axis] + delta);
      return next;
    });
  }

  const seedValue = volume && seed ? voxelValue(volume, seed) : null;
  const seedMm: Vec3 | null = volume && seed ? [seed[0] * volume.spacingMm[0], seed[1] * volume.spacingMm[1], seed[2] * volume.spacingMm[2]] : null;
  const autoWin = useMemo(() => {
    if (!volume || !seed || params.mode !== "auto") return null;
    try {
      const w = windowFromSeed(volume, seed, params.radius, params.k);
      return { lower: w.lower, upper: w.upper, mean: w.mean, sd: w.sd, n: w.n };
    } catch {
      return null;
    }
  }, [volume, seed, params.mode, params.radius, params.k]);
  const manualWin = useMemo(() => {
    const lower = Number(params.lower);
    const upper = Number(params.upper);
    if (params.mode !== "manual" || params.lower === "" || params.upper === "" || !Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    return { lower, upper };
  }, [params.mode, params.lower, params.upper]);
  const segWindow = params.mode === "auto" ? autoWin : manualWin;
  const manualProblem = params.mode === "manual" && (!manualWin || manualWin.lower >= manualWin.upper) ? "Enter a lower value that is below the upper value." : null;

  function findLesionCenterSeed(): Vec3 {
    if (!volume) return [0, 0, 0];
    const [dx, dy, dz] = volume.dims;
    let maxVal = -Infinity;
    let bestVoxel: Vec3 = [Math.floor(dx / 2), Math.floor(dy / 2), Math.floor(dz / 2)];

    const xMin = Math.floor(dx * 0.2);
    const xMax = Math.floor(dx * 0.8);
    const yMin = Math.floor(dy * 0.2);
    const yMax = Math.floor(dy * 0.8);
    const zMin = Math.floor(dz * 0.2);
    const zMax = Math.floor(dz * 0.8);

    for (let z = zMin; z < zMax; z++) {
      for (let y = yMin; y < yMax; y++) {
        for (let x = xMin; x < xMax; x++) {
          const val = voxelValue(volume, [x, y, z]);
          if (val !== null && val > maxVal) {
            maxVal = val;
            bestVoxel = [x, y, z];
          }
        }
      }
    }
    return bestVoxel;
  }

  async function autoPlaceSeedAndSegment() {
    if (!volume) return;
    const bestSeed = findLesionCenterSeed();
    setSeed(bestSeed);
    setCursor(bestSeed);
    await runSegmentation(bestSeed);
  }

  async function runSegmentation(targetSeed?: Vec3) {
    const activeSeed = targetSeed ?? seed;
    if (!volume || !activeSeed) return;
    if (manualProblem) {
      setError(manualProblem);
      return;
    }
    setError(null);
    setStatus("Growing the region from the seed…");
    await tick();
    try {
      const result = segmentFromSeed(volume, {
        seed: activeSeed,
        seedRadiusVoxels: params.radius,
        kSigma: params.k,
        closeIterations: params.close,
        ...(params.mode === "manual" && manualWin ? { window: manualWin } : {}),
      });
      const measurement = measureMask(result.mask);
      let mesh: Seg["mesh"] = null;
      if (result.accepted && result.voxelCount > 0) {
        setStatus("Building the surface…");
        await tick();
        mesh = meshFromMask(result.mask, { blurIterations: 1, taubinIterations: params.smooth });
      }
      const val = voxelValue(volume, activeSeed);
      setSeg({ result, measurement, mesh, seed: activeSeed, seedValue: val, smooth: params.smooth, at: new Date() });
      setRecDone(null);
      setShowSteps(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Segmentation failed.");
    } finally {
      setStatus(null);
    }
  }

  function handleAiSegmentSuccess(ai: AiSegmentSuccess) {
    if (!volume) return;
    if (
      ai.mask.dims[0] !== volume.dims[0] ||
      ai.mask.dims[1] !== volume.dims[1] ||
      ai.mask.dims[2] !== volume.dims[2]
    ) {
      setError(`AI mask dimensions [${ai.mask.dims.join(", ")}] do not match volume dimensions [${volume.dims.join(", ")}].`);
      return;
    }
    if (
      Math.abs(ai.mask.spacingMm[0] - volume.spacingMm[0]) > 0.02 ||
      Math.abs(ai.mask.spacingMm[1] - volume.spacingMm[1]) > 0.02 ||
      Math.abs(ai.mask.spacingMm[2] - volume.spacingMm[2]) > 0.02
    ) {
      setError(
        `AI mask voxel spacing [${ai.mask.spacingMm.map((v) => v.toFixed(3)).join(", ")}] mm does not match source volume spacing [${volume.spacingMm.map((v) => v.toFixed(3)).join(", ")}] mm.`,
      );
      return;
    }
    const measurement = measureMask(ai.mask);
    let mesh: Seg["mesh"] = null;
    if (measurement.voxelCount > 0) {
      mesh = meshFromMask(ai.mask, { blurIterations: 1, taubinIterations: params.smooth });
    }
    const steps: string[] = [
      `Series slices: ${seriesFiles.length}`,
      `Model: ${ai.model.name} (${ai.model.id})`,
      ...(ai.model.architecture ? [`Architecture: ${ai.model.architecture}`] : []),
      ...(ai.model.modelVersion ? [`Model version: ${ai.model.modelVersion}`] : []),
      ...(ai.model.checkpointSha256 ? [`Checkpoint SHA-256: ${ai.model.checkpointSha256.slice(0, 16)}…`] : []),
      `Target structure: ${ai.structureName}`,
      `Voxels segmented: ${ai.voxelCount} (${measurement.volumeMl.toFixed(2)} mL)`,
      `Geometry verification: dims [${ai.mask.dims.join("×")}], spacing [${ai.mask.spacingMm.map((v) => v.toFixed(2)).join("×")} mm] aligned with source scan`,
      ai.note || "Experimental learned model output. Not clinically validated; requires clinician verification.",
    ];
    const result: SegmentResult = {
      segmenter: `${ai.model.name} · ${ai.structureName}`,
      isLearnedModel: true,
      mask: ai.mask,
      window: { lower: 0, upper: 1 },
      voxelCount: measurement.voxelCount,
      volumeMl: measurement.volumeMl,
      steps,
      warnings: ai.voxelCount === 0 ? ["No voxels were predicted for this structure by the model."] : [],
      accepted: ai.voxelCount > 0,
      note: ai.note,
    };
    setShowMask(true);
    setSeg({
      result,
      measurement,
      mesh,
      seed: [Math.floor(volume.dims[0] / 2), Math.floor(volume.dims[1] / 2), Math.floor(volume.dims[2] / 2)],
      seedValue: null,
      smooth: params.smooth,
      at: new Date(),
      aiModel: ai.model,
    });
    setRecDone(null);
    setShowSteps(false);
  }

  async function changeSmoothing(iterations: number) {
    setParams((p) => ({ ...p, smooth: iterations }));
    if (!seg || !seg.result.accepted || seg.result.voxelCount === 0) return;
    setStatus("Rebuilding the surface…");
    await tick();
    try {
      const mesh = meshFromMask(seg.result.mask, { blurIterations: 1, taubinIterations: iterations });
      setSeg((prev) => (prev ? { ...prev, mesh, smooth: iterations } : prev));
    } finally {
      setStatus(null);
    }
  }

  function switchMode(mode: Params["mode"]) {
    setParams((p) => {
      if (mode === "manual" && p.lower === "" && p.upper === "") {
        const base = autoWin ?? (seedValue != null ? { lower: seedValue - win.width * 0.1, upper: seedValue + win.width * 0.1 } : null);
        return { ...p, mode, lower: base ? base.lower.toFixed(1) : "", upper: base ? base.upper.toFixed(1) : "" };
      }
      return { ...p, mode };
    });
  }

  const maskCounts = useMemo(() => (seg ? maskCountsAlong(seg.result.mask, axis) : null), [seg, axis]);
  const extentMm: Vec3 | null = volume
    ? [(volume.dims[0] - 1) * volume.spacingMm[0], (volume.dims[1] - 1) * volume.spacingMm[1], (volume.dims[2] - 1) * volume.spacingMm[2]]
    : null;
  const stale = Boolean(seg && !same(seg.seed, seed));
  const canExport = Boolean(seg && seg.result.accepted && seg.mesh);

  const patientFrame = opened?.series.patientFrame ?? null;
  const exportMesh = useMemo(() => {
    if (!seg?.mesh) return null;
    return patientFrame ? transformMeshToPatient(seg.mesh.mesh, patientFrame) : seg.mesh.mesh;
  }, [seg?.mesh, patientFrame]);

  function makeRecord() {
    if (!opened || !seg) return null;
    return {
      ...buildProcessingRecord({
        now: seg.at,
        modality: opened.series.modality,
        seriesDescription: opened.series.seriesDescription,
        calibrated: opened.series.calibrated,
        report: opened.series.report,
        volume: opened.volume,
        skippedFileCount: opened.series.skipped.length + opened.unreadable,
        seed: seg.seed,
        seedValue: seg.seedValue,
        result: seg.result,
        measurement: seg.measurement,
        mesh: seg.mesh ? { quality: seg.mesh.quality, blurIterations: seg.mesh.blurIterations, taubinIterations: seg.mesh.taubinIterations } : null,
      }),
      preprocessing: preprocessHistory,
      patientCoordinates: opened.series.patientFrame
        ? {
            frame: "dicom_lps",
            originLpsMm: opened.series.patientFrame.origin,
            centroidLpsMm: seg.measurement.centroidMm ? imageMmToPatient(seg.measurement.centroidMm, opened.series.patientFrame) : null,
          }
        : null,
    };
  }

  function exportRecord() {
    const record = makeRecord();
    if (!record) return;
    download("volume-lab-processing-record.json", JSON.stringify(record, null, 2), "application/json");
  }

  function recordAsVersion() {
    const record = makeRecord();
    if (!opened || !seg || !record || !recordFinding || !onRecord || !recFinding) return;

    // Only a DICOM patient frame yields patient-space coordinates. Image-index millimetres are never stored as a centroid.
    const patientCentroidMm = (patientFrame && seg.measurement.centroidMm)
      ? imageMmToPatient(seg.measurement.centroidMm, patientFrame)
      : null;
    const frame = patientFrame ? "dicom_lps" : "unavailable";

    const linked = versionFromLab({
      accepted: seg.result.accepted,
      isLearnedModel: Boolean(seg.result.isLearnedModel),
      clinicianConfirmed: recClinicianConfirmed,
      modelId: seg.result.isLearnedModel ? (seg.aiModel?.id ?? "umd_monai_fibroid") : null,
      measurement: seg.measurement,
      seed: seg.seed,
      recordHash: fnv1a(JSON.stringify(record)),
      seriesDescription: opened.series.seriesDescription,
      source: opened.source,
      reason: recReason,
      patientCentroidMm,
      frame,
      studyId: opened.series.studyUid,
      seriesId: opened.series.seriesUid,
    });
    if (!linked.ok) {
      setError(linked.problem);
      return;
    }
    setError(null);
    const f = linked.fields;

    const newStudyPayload = (opened.source === "upload" && patientId)
      ? {
          patientId,
          modality: opened.series.modality ?? "MR",
          studyDate: opened.series.studyDate ?? new Date().toISOString().slice(0, 10),
          description: opened.series.seriesDescription ? `Uploaded: ${opened.series.seriesDescription}` : "Uploaded pelvic MRI",
          accession: opened.series.accession ?? `ACC-${Date.now().toString().slice(-6)}`,
          sourceNote: "Uploaded DICOM study in Volume Lab",
        }
      : undefined;

    const newSeriesPayload = (opened.source === "upload" && patientId)
      ? {
          seriesNumber: 1,
          description: opened.series.seriesDescription ?? "Uploaded Series",
          plane: PLANES.find((p) => p.axis === axis)?.label ?? "Axial",
          sliceCount: opened.volume.dims[2],
          pixelSpacingMm: opened.series.report.pixelSpacingMm ? `${opened.series.report.pixelSpacingMm[0]}\\${opened.series.report.pixelSpacingMm[1]}` : undefined,
          sliceThicknessMm: opened.series.report.sliceSpacingMm ?? undefined,
        }
      : undefined;

    void onRecord(async () => {
      await recordFinding({
        findingId: recFinding,
        axes: f.axes,
        longest: f.longest,
        sliceIndex: f.sliceIndex,
        reason: recReason.trim(),
        evidenceNote: f.evidenceNote,
        centroidMm: patientCentroidMm,
        frame,
        studyId: opened.series.studyUid,
        seriesId: opened.series.seriesUid,
        modelId: f.modelId,
        segmentationSource: f.segmentationSource,
        segmentationRunId: f.segmentationRunId,
        volumeMm3: Math.round(f.volumeMl * 1000),
        uncertaintyMm3: seg.measurement.uncertaintyMm3 ?? undefined,
        maskArtifact: {
          fileName: `${opened.series.seriesUid || "series"}_mask.rle.json`,
          mimeType: "application/json",
          dataBase64: btoa(
            JSON.stringify({
              dims: seg.result.mask.dims,
              spacingMm: seg.result.mask.spacingMm,
              voxelCount: seg.measurement.voxelCount,
              volumeMm3: seg.measurement.volumeMm3,
            }),
          ),
          metadata: {
            dims: seg.result.mask.dims,
            spacingMm: seg.result.mask.spacingMm,
            voxelCount: seg.measurement.voxelCount,
            method: f.segmentationSource,
          },
        },
        newStudy: newStudyPayload,
        newSeries: newSeriesPayload,
      });
      setRecDone("Saved as a new version. The newly uploaded study and series are genuinely linked to the version with patient LPS coordinates.");
      setRecReason("");
      setRecClinicianConfirmed(false);
    });
  }

  async function runCrossCheck() {
    if (!SERVICE_BASE || !shown || seriesFiles.length === 0) return;
    setCross({ phase: "running" });
    const health = await checkHealth(SERVICE_BASE);
    const res = await inspectWithService(SERVICE_BASE, seriesFiles);
    if (!res.ok) {
      setCross({ phase: "failed", error: res.error });
      return;
    }
    const browserRead = Math.max(0, seriesFiles.length - shown.series.skipped.length);
    setCross({
      phase: "done",
      service: res.value,
      check: compareReports(shown.series.report, browserRead, res.value),
      at: new Date(),
      modelConnected: health.ok ? health.value.any_model_connected : null,
    });
  }

  const shown = opened ?? (reportOnly ? { series: reportOnly.series, source: reportOnly.source, unreadable: reportOnly.unreadable, volume: null } : null);
  const report = shown?.series.report ?? null;
  const plane = PLANES.find((p) => p.axis === axis)!;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-medium text-pine">Volume lab</p>
        <h1 className="text-3xl text-ink">From a DICOM series to a measured, exportable surface</h1>
        <p className="max-w-3xl text-ink-soft">
          Load a series, click inside a structure, and grow a region from that seed. The mask, its measurements, and a 3D surface appear here, and the surface can be exported as STL. Files are read in this browser and are not uploaded or stored.
        </p>
        <div className="flex flex-wrap gap-2">
          <Tag tone="clay">Classical region growing, not a trained model</Tag>
          <Tag>Not clinically validated</Tag>
          <Tag>Patient name and ID are never read into results</Tag>
        </div>
      </header>

      <Card title="1. Load a series">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void filesFromDrop(event.dataTransfer).then(readFiles);
          }}
          className={`space-y-3 rounded-md border border-dashed p-4 ${dragging ? "border-pine bg-pine-soft" : "border-line bg-paper"}`}
        >
          <p className="text-sm text-ink-soft">
            Drop DICOM files or a whole study folder here. Uncompressed series only (explicit or implicit little-endian, 8 or 16-bit). Compressed files are listed as skipped, not guessed. If the folder holds several series, you choose one.
          </p>
          <div className="flex flex-wrap gap-2">
            <Btn tone="ghost" disabled={busy} testId="choose-files" onClick={() => fileInput.current?.click()}>
              Choose files
            </Btn>
            <Btn tone="ghost" disabled={busy} testId="choose-folder" onClick={() => folderInput.current?.click()}>
              Choose a folder
            </Btn>
            <Btn disabled={busy} testId="load-sample" onClick={() => void loadSample()}>
              Load synthetic sample
            </Btn>
          </div>
          <input
            ref={fileInput}
            data-testid="file-input"
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const list = Array.from(event.target.files ?? []);
              event.target.value = "";
              void readFiles(list);
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const list = Array.from(event.target.files ?? []);
              event.target.value = "";
              void readFiles(list);
            }}
          />
        </div>
        {status && (
          <p role="status" className="text-sm text-pine" data-testid="lab-status">
            {status}
          </p>
        )}
        {sourceNote && (
          <p
            className={`rounded-md px-3 py-2 text-sm ${sourceNote.origin === "stored" ? "bg-pine-soft text-pine" : "bg-clay-soft text-clay"}`}
            data-testid="lab-source-note"
          >
            {sourceNote.text}
            {openDemo?.findingVersionId && onOpenEvidence && (
              <button type="button" className="ml-2 underline" data-testid="lab-back-to-evidence" onClick={() => onOpenEvidence(openDemo.findingVersionId as string)}>
                Back to finding evidence and report quote
              </button>
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay" data-testid="lab-error">
            {error}
          </p>
        )}
        {pending && (
          <div className="space-y-2 rounded-md border border-line p-3" data-testid="series-picker">
            <p className="text-sm font-medium text-ink">This folder holds {pending.groups.length} series. Which one?</p>
            <ul className="space-y-1">
              {pending.groups.map((g) => (
                <li key={g.uid}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-paper">
                    <input type="radio" name="series" value={g.uid} checked={pick === g.uid} onChange={() => setPick(g.uid)} />
                    <span className="text-ink">{g.description ?? "(no description)"}</span>
                    <span className="text-muted tabular-nums">
                      {g.modality ?? "?"} · {g.files.length} image{g.files.length === 1 ? "" : "s"} · {g.cols}×{g.rows}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <Btn
              onClick={() => {
                const g = pending.groups.find((x) => x.uid === pick);
                if (g) void open(g, pending.parse, pending.source, pending.unreadable).then(() => setPending(null));
              }}
              disabled={busy}
            >
              Load this series
            </Btn>
          </div>
        )}
      </Card>

      {report && shown && (
        <Card
          title="2. Geometry checks"
          aside={
            <div className="flex flex-wrap gap-2">
              {shown.source === "sample" && <Tag tone="clay">Synthetic sample, not a patient</Tag>}
              <Tag tone={report.volumeReady ? "pine" : "clay"}>{report.volumeReady ? "Volume ready" : "Not stacked"}</Tag>
            </div>
          }
        >
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Slices used" value={String(report.orderedIds.length)} />
            <Stat label="Matrix" value={`${report.cols} × ${report.rows}`} note={report.pixelSpacingMm ? `${report.pixelSpacingMm[1].toFixed(2)} × ${report.pixelSpacingMm[0].toFixed(2)} mm pixels` : "pixel spacing missing"} />
            <Stat label="Slice spacing" value={report.sliceSpacingMm != null ? `${report.sliceSpacingMm.toFixed(2)} mm` : "n/a"} note={report.spatiallyOrdered ? "ordered by position" : "order not established"} />
            <Stat label="Series" value={shown.series.modality ?? "?"} note={shown.series.seriesDescription ?? "no description"} />
          </dl>
          {!shown.series.calibrated && <p className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">No rescale slope or intercept was present, so intensities are stored values, not calibrated units.</p>}
          {report.issues.length === 0 ? (
            <p className="text-sm text-ink-soft">No gaps, duplicates, mixed orientation, or mixed matrix were found.</p>
          ) : (
            <ul className="space-y-1" data-testid="series-issues">
              {report.issues.map((issue, i) => (
                <li key={`${issue.code}-${i}`} className={`rounded-md px-3 py-2 text-sm ${issue.severity === "error" ? "bg-clay-soft text-clay" : "bg-paper text-ink-soft"}`}>
                  <span className="font-medium">{issue.severity === "error" ? "Blocks stacking: " : "Note: "}</span>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
          {(shown.series.skipped.length > 0 || shown.unreadable > 0) && (
            <details className="text-sm text-ink-soft">
              <summary className="cursor-pointer text-muted">
                {shown.series.skipped.length + shown.unreadable} file{shown.series.skipped.length + shown.unreadable === 1 ? "" : "s"} not used
              </summary>
              <ul className="mt-2 space-y-1">
                {shown.series.skipped.slice(0, 20).map((s) => (
                  <li key={s.name}>
                    {s.name}: {s.reason}
                  </li>
                ))}
                {shown.unreadable > 0 && <li>{shown.unreadable} other file(s) were not DICOM images.</li>}
              </ul>
            </details>
          )}
          <p className="text-xs text-muted">Missing slices are reported, never repaired: interpolated slices would put invented pixels under a measurement.</p>
        </Card>
      )}

      {report && shown && (
        <Card
          title="Second check · imaging service"
          aside={
            <div className="flex flex-wrap gap-2">
              <Tag>Optional</Tag>
              {cross.phase === "done" && <Tag tone={cross.check.agreeing === cross.check.comparable ? "pine" : "clay"}>{`${cross.check.agreeing}/${cross.check.comparable} agree`}</Tag>}
            </div>
          }
        >
          <div data-testid="cross-check">
            {!SERVICE_BASE ? (
              <p className="text-sm text-ink-soft">
                Not configured. To get an independent geometry check from the Python service (pydicom), run <code>imaging-service</code> with <code>ANATOMYBRIDGE_CORS_ORIGINS</code> set to this site&apos;s origin and build the app with <code>VITE_IMAGING_SERVICE_URL</code>. Nothing is sent while this is unset.
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-soft">
                  Sends the {seriesFiles.length} file{seriesFiles.length === 1 ? "" : "s"} of this series to <span className="font-medium text-ink">{SERVICE_BASE}</span> for a separate geometry check. File names are replaced with neutral ones. The service reads them in memory, returns no patient tags, and stores nothing. The service has no login of its own, so use it only on a trusted network.
                  {shown.source === "upload" && " Send only de-identified or synthetic data."}
                </p>
                <Btn tone="ghost" disabled={busy || cross.phase === "running" || seriesFiles.length === 0} testId="cross-check-run" onClick={() => void runCrossCheck()}>
                  {cross.phase === "running" ? "Checking…" : cross.phase === "done" ? "Check again" : "Send for a second check"}
                </Btn>
                {cross.phase === "failed" && (
                  <p role="alert" className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">{cross.error} The browser result above is unaffected.</p>
                )}
                {cross.phase === "done" && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-ink">{cross.check.summary}</p>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[34rem] text-left text-sm">
                        <thead className="text-xs text-muted">
                          <tr>
                            <th className="py-1 pr-3 font-medium">Item</th>
                            <th className="py-1 pr-3 font-medium">Browser (dicom-parser)</th>
                            <th className="py-1 pr-3 font-medium">Service (pydicom)</th>
                            <th className="py-1 font-medium">Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cross.check.rows.map((r) => (
                            <tr key={r.item} className="border-t border-line align-top">
                              <td className="py-1 pr-3 text-ink">
                                {r.item}
                                {r.note && <span className="block text-xs text-muted">{r.note}</span>}
                              </td>
                              <td className="py-1 pr-3 tabular-nums text-ink-soft">{r.browser}</td>
                              <td className="py-1 pr-3 tabular-nums text-ink-soft">{r.service}</td>
                              <td className="py-1">
                                {r.agree === null ? <Tag>Not comparable</Tag> : r.agree ? <Tag tone="pine">Agree</Tag> : <Tag tone="clay">Disagree</Tag>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-muted">
                      Checked {cross.at.toLocaleTimeString()}. Segmentation model on the service: {cross.modelConnected == null ? "unknown (health check failed)" : cross.modelConnected ? "connected" : "not connected"}. This check is about geometry only. It is not a segmentation and not clinical validation.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      )}

      {volume && extentMm && hist && opened && (
        <>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Card
              title="3. Place a seed"
              aside={
                <div className="flex flex-wrap gap-1" role="tablist" aria-label="Plane">
                  {PLANES.map((p) => (
                    <button
                      key={p.axis}
                      type="button"
                      role="tab"
                      aria-selected={axis === p.axis}
                      data-testid={`plane-${p.axis}`}
                      onClick={() => setAxis(p.axis)}
                      className={`min-h-11 rounded-md px-3 text-sm ${axis === p.axis ? "bg-pine text-card" : "border border-line bg-card text-ink"}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              }
            >
              <PlaneView
                volume={volume}
                mask={seg?.result.mask ?? null}
                axis={axis}
                cursor={cursor}
                seed={seed}
                win={win}
                showMask={showMask}
                maskAlpha={maskAlpha}
                onPick={placeSeed}
                onStep={step}
              />
              <div className="space-y-2">
                <label className="block text-xs text-muted">
                  Slice {cursor[axis] + 1} of {volume.dims[axis]}
                  <input
                    data-testid="slice-slider"
                    className="mt-1 w-full"
                    type="range"
                    min={0}
                    max={volume.dims[axis] - 1}
                    value={cursor[axis]}
                    onChange={(event) =>
                      setCursor((c) => {
                        const next: Vec3 = [c[0], c[1], c[2]];
                        next[axis] = Number(event.target.value);
                        return next;
                      })
                    }
                  />
                </label>
                {maskCounts && (
                  <svg viewBox={`0 0 ${maskCounts.length} 10`} preserveAspectRatio="none" className="h-8 w-full rounded-sm bg-paper" role="img" aria-label="Where the mask lies along the slice axis. Click to jump.">
                    {maskCounts.map((c, i) => {
                      const peak = Math.max(1, ...maskCounts);
                      const h = c === 0 ? 0 : Math.max(1, (c / peak) * 10);
                      return (
                        <rect
                          key={i}
                          x={i}
                          y={10 - h}
                          width={0.9}
                          height={h}
                          fill={i === cursor[axis] ? "#1e4a42" : "#9a4634"}
                          onClick={() =>
                            setCursor((cur) => {
                              const next: Vec3 = [cur[0], cur[1], cur[2]];
                              next[axis] = i;
                              return next;
                            })
                          }
                        />
                      );
                    })}
                  </svg>
                )}
                <p className="text-xs text-muted">{plane.hint} Wheel, arrow keys, or the slider change slice. Slice index increases upward in reformats.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-muted">
                  Brightness
                  <input
                    className="mt-1 w-full"
                    type="range"
                    min={hist.lo}
                    max={hist.hi}
                    step={(hist.hi - hist.lo) / 200}
                    value={Math.min(hist.hi, Math.max(hist.lo, win.center))}
                    onChange={(event) => setWin((w) => ({ ...w, center: Number(event.target.value) }))}
                  />
                </label>
                <label className="block text-xs text-muted">
                  Contrast (window width)
                  <input
                    className="mt-1 w-full"
                    type="range"
                    min={hist.binWidth * 2}
                    max={(hist.hi - hist.lo) * 2}
                    step={(hist.hi - hist.lo) / 200}
                    value={Math.min((hist.hi - hist.lo) * 2, Math.max(hist.binWidth * 2, win.width))}
                    onChange={(event) => setWin((w) => ({ ...w, width: Number(event.target.value) }))}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Btn
                  tone="ghost"
                  onClick={() => {
                    const w = autoWindow(volume);
                    setWin({ center: w.center, width: w.width });
                  }}
                >
                  Reset display
                </Btn>
                <label className="flex min-h-11 items-center gap-2 text-sm text-ink-soft">
                  <input type="checkbox" checked={showMask} onChange={(event) => setShowMask(event.target.checked)} />
                  Show mask
                </label>
                <label className="flex min-h-11 items-center gap-2 text-xs text-muted">
                  Opacity
                  <input type="range" min={0.1} max={0.9} step={0.05} value={maskAlpha} onChange={(event) => setMaskAlpha(Number(event.target.value))} />
                </label>
              </div>
              <p className="text-xs text-muted">Brightness and contrast change only what you see. They never change the segmentation.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-paper p-3">
                {seed ? (
                  <>
                    <Btn tone="pine" onClick={() => void runSegmentation()} disabled={busy}>
                      ▶ Run Segmentation & Build 3D Surface
                    </Btn>
                    <Btn tone="ghost" onClick={() => void autoPlaceSeedAndSegment()} disabled={busy}>
                      🎯 Re-detect Lesion Center
                    </Btn>
                    <span className="text-xs text-muted">Seed voxel: ({seed.join(", ")})</span>
                  </>
                ) : (
                  <>
                    <Btn tone="pine" onClick={() => void autoPlaceSeedAndSegment()} disabled={busy}>
                      🎯 Auto-Place Seed at Lesion & Run Segmentation
                    </Btn>
                    <span className="text-xs text-muted">Or click directly inside the lesion on the slice above.</span>
                  </>
                )}
              </div>
            </Card>

            <Card
              title="3b. Preprocessing & Quality"
              aside={
                preprocessHistory.length > 0 && (
                  <Btn tone="ghost" onClick={revertPreprocessing} testId="revert-preprocess">
                    Revert to raw
                  </Btn>
                )
              }
            >
              {quality && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Estimated Noise SD" value={quality.noiseSd > 0 ? quality.noiseSd.toFixed(2) : "0.00"} />
                  <Stat label="Slice Anisotropy" value={`${quality.anisotropy.toFixed(1)}×`} note={quality.anisotropy > 3 ? "Thick slices" : "Near-isotropic"} />
                  <Stat label="Dynamic Range / Noise" value={quality.dynamicRangeToNoise ? quality.dynamicRangeToNoise.toFixed(1) : "n/a"} />
                </div>
              )}
              {quality?.flags && quality.flags.length > 0 && (
                <div className="rounded-md bg-clay-soft px-3 py-2 text-xs text-clay">
                  {quality.flags.map((f, i) => (
                    <p key={i}>{f}</p>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Btn tone="ghost" testId="apply-median" onClick={applyMedian}>
                  3×3×3 Median Filter
                </Btn>
                <Btn tone="ghost" testId="apply-percentile" onClick={applyPercentile}>
                  Percentile Norm (0.5–99.5%)
                </Btn>
                <Btn tone="ghost" testId="apply-zscore" onClick={applyZScore}>
                  Z-Score Norm
                </Btn>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">Gaussian σ:</span>
                  <input
                    type="range"
                    min={0.5}
                    max={3.0}
                    step={0.5}
                    value={gaussSigma}
                    onChange={(e) => setGaussSigma(Number(e.target.value))}
                    className="w-16"
                  />
                  <span className="text-xs tabular-nums text-muted">{gaussSigma.toFixed(1)}mm</span>
                  <Btn tone="ghost" testId="apply-gaussian" onClick={applyGaussian}>
                    Apply Gaussian
                  </Btn>
                </div>
              </div>
              {preprocessHistory.length > 0 ? (
                <div className="space-y-1 rounded-md bg-paper p-3 text-xs">
                  <p className="font-semibold text-ink">Operation History ({preprocessHistory.length}):</p>
                  <ol className="list-decimal space-y-1 pl-4 text-muted">
                    {preprocessHistory.map((op, idx) => (
                      <li key={idx}>
                        <span className="font-medium text-ink">{op.op}</span>: {op.note}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <p className="text-xs text-muted">Raw volume active. Filter operations apply non-destructively with full audit provenance.</p>
              )}
            </Card>

            <Card
              title="4. 3D surface"
              aside={
                <Btn tone="ghost" onClick={() => stage.current?.resetView()}>
                  Reset view
                </Btn>
              }
              className="flex flex-col"
            >
              <div className="min-h-96 flex-1 overflow-hidden rounded-md border border-line">
                <VolumeStage
                  ref={stage}
                  mesh={seg?.mesh?.mesh ?? null}
                  extentMm={extentMm}
                  plane={{ axis, mm: cursor[axis] * volume.spacingMm[axis] }}
                  seedMm={seedMm}
                />
              </div>
              <p className="text-xs text-muted">
                Drag to rotate, wheel to zoom, right-drag to pan. The box is the scanned volume ({extentMm.map((n) => n.toFixed(0)).join(" × ")} mm). The grey plane is the slice on the left; the clay dot is the seed. Axes: x columns red, y rows green, z slices blue. Coordinates are image millimetres, not patient coordinates.
              </p>
              {!seg && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-paper p-3 text-sm text-ink-soft">
                  <span>No surface yet. Place a seed on the slice, or auto-detect lesion:</span>
                  <Btn tone="pine" onClick={() => void autoPlaceSeedAndSegment()} disabled={busy}>
                    🎯 Auto-Place Seed & Segment
                  </Btn>
                </div>
              )}
              {seg && !seg.mesh && <p className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">No surface was built because the result was not accepted or was empty.</p>}
            </Card>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <Card title="5. Segment from the seed">
              <div className="rounded-md bg-paper p-3 text-sm" data-testid="seed-readout">
                {seed && seedMm ? (
                  <p className="tabular-nums text-ink">
                    Seed voxel ({seed.join(", ")}) · intensity {fmt(seedValue)} · at ({seedMm.map((n) => n.toFixed(1)).join(", ")}) mm
                  </p>
                ) : (
                  <p className="text-ink-soft">Click inside the structure you want to outline. The seed decides what is segmented.</p>
                )}
              </div>
              <HistogramBars hist={hist} display={win} segWindow={segWindow ? { lower: segWindow.lower, upper: segWindow.upper } : null} seedValue={seedValue} />
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">Intensity window</legend>
                <div className="flex flex-wrap gap-4 text-sm text-ink-soft">
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="radio" name="mode" checked={params.mode === "auto"} onChange={() => switchMode("auto")} />
                    From the seed (mean ± k·sd)
                  </label>
                  <label className="flex min-h-11 items-center gap-2">
                    <input type="radio" name="mode" checked={params.mode === "manual"} onChange={() => switchMode("manual")} />
                    Set it myself
                  </label>
                </div>
                {params.mode === "auto" ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs text-muted">
                      k (width in standard deviations): {params.k.toFixed(1)}
                      <input className="mt-1 w-full" type="range" min={1} max={4} step={0.1} value={params.k} onChange={(event) => setParams((p) => ({ ...p, k: Number(event.target.value) }))} />
                    </label>
                    <label className="block text-xs text-muted">
                      Seed neighbourhood radius: {params.radius} voxel{params.radius === 1 ? "" : "s"}
                      <input className="mt-1 w-full" type="range" min={1} max={5} step={1} value={params.radius} onChange={(event) => setParams((p) => ({ ...p, radius: Number(event.target.value) }))} />
                    </label>
                    <p className="text-xs text-muted sm:col-span-2" data-testid="auto-window">
                      {autoWin ? `Window ${autoWin.lower.toFixed(1)} to ${autoWin.upper.toFixed(1)} from ${autoWin.n} voxels (mean ${autoWin.mean.toFixed(1)}, sd ${autoWin.sd.toFixed(1)}).` : "Place a seed to see the window."}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-xs text-muted">
                      Lower
                      <input
                        data-testid="window-lower"
                        inputMode="decimal"
                        className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                        value={params.lower}
                        onChange={(event) => setParams((p) => ({ ...p, lower: event.target.value }))}
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      Upper
                      <input
                        data-testid="window-upper"
                        inputMode="decimal"
                        className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                        value={params.upper}
                        onChange={(event) => setParams((p) => ({ ...p, upper: event.target.value }))}
                      />
                    </label>
                    {manualProblem && <p className="col-span-2 text-xs text-clay">{manualProblem}</p>}
                  </div>
                )}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-muted">
                  Close small holes: {params.close} step{params.close === 1 ? "" : "s"}
                  <input className="mt-1 w-full" type="range" min={0} max={3} step={1} value={params.close} onChange={(event) => setParams((p) => ({ ...p, close: Number(event.target.value) }))} />
                </label>
                <label className="block text-xs text-muted">
                  Surface smoothing (Taubin)
                  <select
                    data-testid="smooth-select"
                    className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                    value={params.smooth}
                    onChange={(event) => void changeSmoothing(Number(event.target.value))}
                  >
                    <option value={0}>None</option>
                    <option value={10}>10 passes</option>
                    <option value={20}>20 passes</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Btn testId="run-segmentation" onClick={() => void runSegmentation()} disabled={!seed || busy}>
                  {seg ? "Segment again from this seed" : "Segment from seed"}
                </Btn>
                {stale && <Tag tone="clay">Seed moved: the result below is from the previous seed</Tag>}
              </div>
              <p className="text-xs text-muted">
                This is seeded region growing inside an intensity window, then cleanup. It has no anatomical knowledge: it cannot tell a fibroid from any other tissue of similar intensity. A person must judge the outline against the images.
              </p>
              <div className="mt-4 border-t border-line/60 pt-4">
                <ModelStatusPanel
                  seriesFiles={seriesFiles}
                  sourceGeometry={{
                    dims: volume.dims,
                    spacingMm: volume.spacingMm,
                    originLpsMm: patientFrame?.origin ?? null,
                    directionCosines: patientFrame
                      ? [...patientFrame.rowCosines, ...patientFrame.colCosines, ...patientFrame.sliceCosines]
                      : null,
                    frameOfReferenceUid: patientFrame?.frameOfReferenceUid ?? null,
                  }}
                  disabled={busy}
                  showOverlay={showMask}
                  onToggleOverlay={setShowMask}
                  onSegmentSuccess={handleAiSegmentSuccess}
                />
              </div>
            </Card>

            <Card
              title="6. Result"
              aside={
                seg ? (
                  <div className="flex flex-wrap gap-2">
                    <Tag tone={seg.result.accepted ? "pine" : "clay"}>{seg.result.accepted ? "Accepted by the leakage check" : "Not accepted"}</Tag>
                    <Tag tone={seg.result.isLearnedModel ? "pine" : undefined}>{seg.result.isLearnedModel ? "Learned AI Model" : seg.result.segmenter}</Tag>
                  </div>
                ) : undefined
              }
            >
              {!seg ? (
                <p className="rounded-md bg-paper px-3 py-6 text-center text-sm text-ink-soft">Measurements, mesh checks, and the processing history appear here after a segmentation.</p>
              ) : (
                <div className="space-y-4" data-testid="result-panel">
                  {seg.result.isLearnedModel && (
                    <div className="rounded-md bg-paper p-3 text-xs text-ink" data-testid="ai-model-disclaimer">
                      <strong className="text-ink">AI Model Output:</strong> {seg.result.note || "Genuine learned model output. Not clinician-verified."}
                    </div>
                  )}
                  {seg.result.warnings.length > 0 && (
                    <ul className="space-y-1" data-testid="result-warnings">
                      {seg.result.warnings.map((w) => (
                        <li key={w} className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">
                          {w}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                    <Stat label="Volume" value={`${fmt(seg.measurement.volumeMl, 2)} mL`} note={`${seg.measurement.voxelCount} voxels`} />
                    <Stat label="Longest extent" value={seg.measurement.longestMm != null ? `${seg.measurement.longestMm.toFixed(1)} mm` : "n/a"} note="principal axis" />
                    <Stat label="Principal extents" value={seg.measurement.axesMm ? seg.measurement.axesMm.map((n) => n.toFixed(0)).join(" × ") + " mm" : "n/a"} />
                    <Stat label="Connected parts" value={String(seg.measurement.componentCount)} note={`${(seg.measurement.largestComponentFraction * 100).toFixed(0)}% in the largest`} />
                    <Stat label="Centroid" value={seg.measurement.centroidMm ? seg.measurement.centroidMm.map((n) => n.toFixed(0)).join(", ") : "n/a"} note="mm, image space" />
                    <Stat label="Window used" value={`${seg.result.window.lower.toFixed(0)} to ${seg.result.window.upper.toFixed(0)}`} />
                  </div>
                  <p className="text-xs text-muted">{seg.measurement.method}. These are not a clinician's caliper measurements and are not clinically validated.</p>
                  {seg.mesh && (
                    <div className="space-y-2">
                      <h3 className="text-lg">Surface checks</h3>
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="mesh-quality">
                        <Stat label="Triangles" value={seg.mesh.quality.triangleCount.toLocaleString()} />
                        <Stat label="Watertight" value={seg.mesh.quality.watertight ? "Yes" : "No"} note={`Euler ${seg.mesh.quality.eulerCharacteristic}`} />
                        <Stat label="Surface area" value={`${(seg.mesh.quality.surfaceAreaMm2 / 100).toFixed(1)} cm²`} />
                        <Stat
                          label="Mesh volume"
                          value={seg.mesh.quality.enclosedVolumeMl != null ? `${seg.mesh.quality.enclosedVolumeMl.toFixed(2)} mL` : "n/a"}
                          note={seg.mesh.quality.enclosedVolumeMl != null && seg.measurement.volumeMl > 0 ? `${(((seg.mesh.quality.enclosedVolumeMl - seg.measurement.volumeMl) / seg.measurement.volumeMl) * 100).toFixed(1)}% vs voxels` : undefined}
                        />
                      </div>
                      {!seg.mesh.quality.watertight && <p className="rounded-md bg-clay-soft px-3 py-2 text-sm text-clay">The surface has open or non-manifold edges. Check it before using it for printing or volume.</p>}
                    </div>
                  )}
                  <div className="space-y-2">
                    <h3 className="text-lg">Export</h3>
                    <div className="flex flex-wrap gap-2">
                      <Btn testId="export-stl" disabled={!canExport} onClick={() => exportMesh && download("volume-lab-surface.stl", toBinaryStl(exportMesh) as unknown as BlobPart, "model/stl")}>
                        Download STL {patientFrame ? "(Patient LPS)" : "(Image mm)"}
                      </Btn>
                      <Btn tone="ghost" testId="export-obj" disabled={!canExport} onClick={() => exportMesh && download("volume-lab-surface.obj", toObj(exportMesh), "text/plain")}>
                        Download OBJ {patientFrame ? "(Patient LPS)" : "(Image mm)"}
                      </Btn>
                      <Btn tone="ghost" testId="export-record" onClick={exportRecord}>
                        Download processing record
                      </Btn>
                    </div>
                    <p className="text-xs text-muted">
                      {canExport
                        ? patientFrame
                          ? "STL and OBJ vertices are transformed into DICOM Patient LPS coordinates (mm). The record captures the full processing pipeline and provenance."
                          : "STL and OBJ are in millimetres in image space. The record lists the seed, window, steps, and checks, with no file names or identifiers."
                        : "Surface export is off until a result passes the leakage check. Narrow the window or move the seed."}
                    </p>
                  </div>
                  {recordFinding && onRecord && (
                    <div className="space-y-2" data-testid="record-version">
                      <h3 className="text-lg">Record as a finding version</h3>
                      {findings.length === 0 ? (
                        <p className="text-sm text-ink-soft">Pick a patient with findings to record this measurement against one.</p>
                      ) : (
                        <>
                          <label className="block text-sm text-ink-soft">
                            Finding
                            <select className="mt-1 block min-h-11 w-full rounded-md border border-line bg-card px-2 text-ink" value={recFinding} onChange={(e) => setRecFinding(e.target.value)} data-testid="record-finding">
                              <option value="">Choose a finding…</option>
                              {findings.map((f) => (
                                <option key={f.id} value={f.id}>
                                  {f.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block text-sm text-ink-soft">
                            Why record this (kept in the audit trail)
                            <input className="mt-1 block min-h-11 w-full rounded-md border border-line bg-card px-2 text-ink" value={recReason} onChange={(e) => setRecReason(e.target.value)} maxLength={400} data-testid="record-reason" />
                          </label>
                          {seg.result.isLearnedModel && (
                            <label className="flex items-start gap-2 rounded-md border border-pine/30 bg-pine-soft/20 p-2 text-xs text-ink" data-testid="clinician-confirm-wrapper">
                              <input
                                type="checkbox"
                                data-testid="record-clinician-confirm"
                                className="mt-0.5"
                                checked={recClinicianConfirmed}
                                onChange={(e) => setRecClinicianConfirmed(e.target.checked)}
                              />
                              <span>
                                <strong>Clinician verification:</strong> I have reviewed this learned AI model segmentation against the native DICOM images and confirm its anatomical boundaries for clinical record keeping.
                              </span>
                            </label>
                          )}
                          <Btn
                            testId="record-version-btn"
                            disabled={busy || !recFinding || recReason.trim().length < 8 || !canExport || (Boolean(seg.result.isLearnedModel) && !recClinicianConfirmed)}
                            onClick={recordAsVersion}
                          >
                            Add as new version
                          </Btn>
                          <p className="text-xs text-muted">
                            Adds version N+1 and keeps every earlier version. Stored: three extents, the longest extent, the seed slice, a note and a hash of the processing record. Not stored: pixels, the mask, the mesh, names, IDs. The centroid is withheld and the frame is marked unavailable, so ReproTrace cannot pair it with an earlier finding automatically. It will appear as unpaired, provisional proposals for a clinician to resolve. The loaded series is not proven to be the study this finding cites.
                          </p>
                          {recDone && <p className="rounded-md bg-pine-soft px-3 py-2 text-sm text-pine">{recDone}</p>}
                        </>
                      )}
                    </div>
                  )}
                  <div>
                    <button type="button" className="min-h-11 text-sm text-pine underline" onClick={() => setShowSteps((v) => !v)} aria-expanded={showSteps}>
                      {showSteps ? "Hide" : "Show"} processing history
                    </button>
                    {showSteps && (
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-soft" data-testid="processing-steps">
                        {seg.result.steps.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                        {seg.mesh && <li>surface from mask: 1 blur pass, marching tetrahedra at 0.5{seg.mesh.taubinIterations > 0 ? `, Taubin smoothing × ${seg.mesh.taubinIterations}` : ""}</li>}
                      </ol>
                    )}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
