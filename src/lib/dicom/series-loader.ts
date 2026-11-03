/**
 * Reads many DICOM files into one validated volume. The parser is injected (dicom-parser in the app, a tiny
 * stand-in in tests), so this logic is testable without it. Patient name and ID are never read into the result.
 */
import { readDicom, type DataSetLike } from "./codec.ts";
import { decodePixels } from "./pixels.ts";
import { analyzeSeries, buildVolume, geometryFromMetadata, type SeriesReport, type SliceGeometry } from "../imaging/series.ts";
import type { Volume } from "../imaging/volume.ts";
import { createPatientFrame, type PatientFrame } from "../imaging/patient-coords.ts";

export type LoadedSeries = {
  report: SeriesReport;
  volume: Volume | null;
  /** Files that could not be used, with the reason. */
  skipped: { name: string; reason: string }[];
  warnings: string[];
  seriesDescription: string | null;
  modality: string | null;
  /** Rescale was present on every slice. When false, intensities are stored values, not calibrated. */
  calibrated: boolean;
  studyUid: string | null;
  seriesUid: string | null;
  studyDate: string | null;
  accession: string | null;
  patientFrame: PatientFrame | null;
};

const UNCOMPRESSED = new Set(["", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2"]);

function num(ds: DataSetLike, tag: string): number | undefined {
  const raw = ds.string(tag);
  if (raw == null) return undefined;
  const n = Number(raw.replace(/\0/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

export function loadSeries(
  files: { name: string; bytes: Uint8Array }[],
  parse: (b: Uint8Array) => DataSetLike,
): LoadedSeries {
  const skipped: LoadedSeries["skipped"] = [];
  const warnings: string[] = [];
  const geoms: SliceGeometry[] = [];
  const pixels = new Map<string, Float32Array>();
  let calibrated = true;
  let seriesDescription: string | null = null;
  let modality: string | null = null;
  let studyUid: string | null = null;
  let seriesUid: string | null = null;
  let studyDate: string | null = null;
  let accession: string | null = null;

  for (const f of files) {
    try {
      const ds = parse(f.bytes);
      const read = readDicom(f.bytes, () => ds);
      const transfer = read.transferSyntax;
      if (!UNCOMPRESSED.has(transfer)) {
        skipped.push({ name: f.name, reason: "Compressed transfer syntax; pixels are not decoded." });
        continue;
      }
      const pixelEl = ds.elements.x7fe00010;
      if (!pixelEl) {
        skipped.push({ name: f.name, reason: "No pixel data." });
        continue;
      }
      const bits = ds.uint16("x00280100");
      if (bits !== 8 && bits !== 16) {
        skipped.push({ name: f.name, reason: `Unsupported bits allocated (${bits ?? "missing"}).` });
        continue;
      }
      const slope = num(ds, "x00281053");
      const intercept = num(ds, "x00281052");
      if (slope == null && intercept == null) calibrated = false;
      const decoded = decodePixels(ds.byteArray.subarray(pixelEl.dataOffset, pixelEl.dataOffset + pixelEl.length), {
        rows: read.rows,
        cols: read.cols,
        bitsAllocated: bits,
        pixelRepresentation: ds.uint16("x00280103") === 1 ? 1 : 0,
        littleEndian: true,
        slope,
        intercept,
        samplesPerPixel: ds.uint16("x00280002") ?? 1,
      });
      const g = geometryFromMetadata(f.name, read.metadata, read.rows, read.cols);
      geoms.push(g);
      pixels.set(f.name, decoded.pixels);
      seriesDescription ??= read.metadata["Series description"] ?? null;
      modality ??= read.metadata["Modality"] ?? null;
      studyUid ??= read.metadata["Study UID"] ?? null;
      seriesUid ??= read.metadata["Series UID"] ?? null;
      studyDate ??= read.metadata["Study date"] ?? null;
      accession ??= read.metadata["Accession"] ?? null;
    } catch (e) {
      skipped.push({ name: f.name, reason: e instanceof Error ? e.message : "Could not be read as DICOM." });
    }
  }
  if (!calibrated) warnings.push("At least one slice has no rescale slope/intercept, so intensities are stored values, not calibrated.");
  if (skipped.length) warnings.push(`${skipped.length} file${skipped.length === 1 ? " was" : "s were"} not used.`);

  const report = analyzeSeries(geoms);
  let volume: Volume | null = null;
  if (report.volumeReady) {
    volume = buildVolume(report, pixels);
    // Explicitly free intermediate individual slice buffers immediately to reduce peak heap pressure
    pixels.clear();
  }

  let patientFrame: PatientFrame | null = null;
  if (report.volumeReady && report.orderedIds.length > 0 && report.pixelSpacingMm && report.sliceSpacingMm != null) {
    const firstGeom = geoms.find((g) => g.id === report.orderedIds[0]);
    const secondGeom = report.orderedIds.length > 1 ? geoms.find((g) => g.id === report.orderedIds[1]) : null;
    if (firstGeom?.positionMm && firstGeom?.orientation) {
      patientFrame = createPatientFrame(
        firstGeom.positionMm,
        firstGeom.orientation,
        [report.pixelSpacingMm[1], report.pixelSpacingMm[0], report.sliceSpacingMm],
        secondGeom?.positionMm ?? null,
        firstGeom.seriesUid ?? seriesUid,
      );
    }
  }

  return { report, volume, skipped, warnings, seriesDescription, modality, calibrated, studyUid, seriesUid, studyDate, accession, patientFrame };
}
