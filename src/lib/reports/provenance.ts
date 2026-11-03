/**
 * Builds the source-to-anatomy evidence chain for one finding version from already-loaded rows:
 * report -> extraction -> quote (page, offsets) -> finding -> version -> study -> series -> SOP/slice
 * -> patient-space coordinate -> registration. Pure. Missing links are reported as gaps, never filled in.
 */
type Row = Record<string, unknown>;

export type EvidenceWorkspace = {
  reports: Row[];
  extractions?: Row[];
  evidence: Row[];
  versions: Row[];
  findings: Row[];
  studies: Row[];
  series: Row[];
  registrations?: Row[];
};

export type SpatialStatus = "spatially_anchored" | "schematic_only" | "no_coordinates" | "coordinates_without_image";

export type ReportLinkTrace = {
  evidenceId: string;
  reportId: string;
  reportDate: string | null;
  extractionId: string | null;
  quote: string;
  quoteStart: number | null;
  quoteEnd: number | null;
  pageNumber: number | null;
  provenance: string | null;
  quoteVerified: boolean;
  reviewStatus: string;
  reviewedBy: string | null;
};

export type EvidenceChain = {
  versionId: string;
  findingId: string | null;
  findingCode: string | null;
  versionNo: number | null;
  study: { id: string; date: string | null; modality: string | null; studyInstanceUid: string | null } | null;
  series: { id: string; description: string | null; seriesInstanceUid: string | null; frameOfReferenceUid: string | null; sliceCount: number | null } | null;
  reportLinks: ReportLinkTrace[];
  imageAnchor: {
    sliceIndex: number | null;
    sopInstanceUid: string | null;
    frameNumber: number | null;
    coordinateFrame: string | null;
    centroidLps: [number, number, number] | null;
    sourceArtifactRef: string | null;
  } | null;
  spatialStatus: SpatialStatus;
  verificationStatus: "clinician_verified" | "needs_review";
  registrationIds: string[];
  gaps: string[];
};

const str = (r: Row | undefined, k: string): string | null => (r && r[k] != null && r[k] !== "" ? String(r[k]) : null);
const numOr = (r: Row | undefined, k: string): number | null => {
  const v = r?.[k];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function triple(v: unknown): [number, number, number] | null {
  const raw = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  return Array.isArray(raw) && raw.length === 3 && raw.every((x) => Number.isFinite(Number(x)))
    ? [Number(raw[0]), Number(raw[1]), Number(raw[2])]
    : null;
}

export function buildEvidenceChain(ws: EvidenceWorkspace, versionId: string): EvidenceChain {
  const gaps: string[] = [];
  const v = ws.versions.find((x) => str(x, "id") === versionId);
  const finding = ws.findings.find((f) => str(f, "id") === str(v, "finding_id"));
  const links = ws.evidence.filter((e) => str(e, "finding_version_id") === versionId);
  const studyRow = ws.studies.find((s) => str(s, "id") === str(v, "study_id"));
  const imageLink = links.find((e) => numOr(e, "slice_index") != null || str(e, "sop_instance_uid")) ?? links.find((e) => str(e, "series_id"));
  const seriesId = str(v, "series_id") ?? str(imageLink, "series_id");
  const seriesRow = ws.series.find((s) => str(s, "id") === seriesId);

  const reportLinks: ReportLinkTrace[] = links
    .filter((e) => str(e, "report_id") && str(e, "quote"))
    .map((e) => {
      const report = ws.reports.find((r) => str(r, "id") === str(e, "report_id"));
      const qs = numOr(e, "quote_start");
      const qe = numOr(e, "quote_end");
      const body = str(report, "body") ?? "";
      const quote = str(e, "quote") ?? "";
      return {
        evidenceId: str(e, "id") ?? "",
        reportId: str(e, "report_id") ?? "",
        reportDate: str(report, "report_date"),
        extractionId: str(e, "extraction_id") ?? str(ws.extractions?.find((x) => str(x, "report_id") === str(e, "report_id")), "id"),
        quote,
        quoteStart: qs,
        quoteEnd: qe,
        pageNumber: numOr(e, "page_number"),
        provenance: str(e, "extraction_provenance"),
        quoteVerified: qs != null && qe != null && body.slice(qs, qe) === quote,
        reviewStatus: str(e, "review_status") ?? (str(e, "kind") === "report_quote" ? "clinician_verified" : "needs_review"),
        reviewedBy: str(e, "reviewed_by"),
      };
    });

  const centroid = triple(v?.centroid_mm);
  const frame = str(v, "frame");
  const spatialStatus: SpatialStatus = !centroid || frame === "unavailable"
    ? "no_coordinates"
    : frame === "schematic"
      ? "schematic_only"
      : seriesRow && (frame === "dicom_lps" || frame === "image_registered")
        ? "spatially_anchored"
        : "coordinates_without_image";

  if (!v) gaps.push("Finding version not found.");
  if (reportLinks.length === 0) gaps.push("No report quotation is linked to this version.");
  if (reportLinks.some((r) => r.quoteStart != null && !r.quoteVerified)) gaps.push("A linked quote no longer matches the stored report text.");
  if (reportLinks.some((r) => r.pageNumber == null)) gaps.push("Page number not recorded for at least one quote (linked before page tracking).");
  if (!seriesRow) gaps.push("No DICOM series is linked.");
  if (seriesRow && !str(seriesRow, "series_instance_uid")) gaps.push("Series has no SeriesInstanceUID on file.");
  if (!imageLink || numOr(imageLink, "slice_index") == null) gaps.push("No source slice index recorded.");
  if (imageLink && !str(imageLink, "sop_instance_uid")) gaps.push("No SOP Instance UID recorded for the source image.");
  if (spatialStatus === "no_coordinates") gaps.push("No patient-space coordinate: the finding has a report link but no verified imaging anchor.");
  if (spatialStatus === "schematic_only") gaps.push("Coordinates are schematic teaching placements, not a spatial anchor in source images.");
  if (spatialStatus === "coordinates_without_image") gaps.push("Coordinates exist but the source series is not linked, so the anchor cannot be verified.");

  const registrationIds = (ws.registrations ?? [])
    .filter((r) => seriesId && (str(r, "fixed_series_id") === seriesId || str(r, "moving_series_id") === seriesId))
    .map((r) => str(r, "id") ?? "");

  return {
    versionId,
    findingId: str(finding, "id"),
    findingCode: str(finding, "code"),
    versionNo: numOr(v, "version_no"),
    study: studyRow
      ? { id: str(studyRow, "id")!, date: str(studyRow, "study_date"), modality: str(studyRow, "modality"), studyInstanceUid: str(studyRow, "study_instance_uid") }
      : null,
    series: seriesRow
      ? {
          id: str(seriesRow, "id")!,
          description: str(seriesRow, "description"),
          seriesInstanceUid: str(seriesRow, "series_instance_uid"),
          frameOfReferenceUid: str(seriesRow, "frame_of_reference_uid"),
          sliceCount: numOr(seriesRow, "slice_count"),
        }
      : null,
    reportLinks,
    imageAnchor: imageLink
      ? {
          sliceIndex: numOr(imageLink, "slice_index"),
          sopInstanceUid: str(imageLink, "sop_instance_uid"),
          frameNumber: numOr(imageLink, "frame_number"),
          coordinateFrame: str(imageLink, "coordinate_frame") ?? frame,
          centroidLps: frame === "dicom_lps" || frame === "image_registered" ? centroid : null,
          sourceArtifactRef: str(imageLink, "source_artifact_ref") ?? str(imageLink, "imaging_object_id"),
        }
      : null,
    spatialStatus,
    verificationStatus: reportLinks.some((r) => r.reviewStatus === "clinician_verified") ? "clinician_verified" : "needs_review",
    registrationIds,
    gaps,
  };
}
