/**
 * Server-side persistent storage, integrity verification, PHI scrubbing, and historical
 * evidence retrieval for medical imaging artifacts (Sprint 3 Task 1 & Final Completion Sprint 1 Task 1).
 *
 * Security & Authorization Invariants (Fail-Closed):
 * 1. All authorization checks (`checkPatientAndClinicianAccess` and `verifyCallerIdentityAndProfile`)
 *    fail closed: a missing user profile or any database query failure immediately throws an
 *    authorization error and NEVER grants access.
 * 2. Caller identity and profile are verified before accessing or mutating any imaging objects.
 * 3. Patients can read/list/verify only their own (`patient.user_id === userId && patient.is_self`)
 *    imaging objects and cannot upload or purge clinical imaging artifacts.
 * 4. Clinicians must hold an active approved verification status (`verified` or `approved`) with
 *    non-empty licence number and registry; unverified, pending, rejected, suspended, or revoked
 *    clinicians are immediately denied.
 * 5. Cross-user access by a verified clinician requires an active, non-expired, non-revoked consent
 *    in `patient_clinician_consents` granting `'view_imaging'` for retrieval/listing/integrity and
 *    additionally `'add_annotations'` or `'review_ai_findings'` for upload/mutation/purge.
 * 6. Identical authorization rules apply to original DICOM files, volumes, segmentation masks,
 *    3D meshes, and report artifacts.
 * 7. Cross-patient manipulated IDs (`patientId`, `objectId`, `studyId`, `seriesId`, `findingId`,
 *    `findingVersionId`, `sourceObjectId`) are validated against the target patient record.
 * 8. Error messages and stored metadata never leak internal filesystem roots, credentials, or PHI.
 */
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Sql } from "../db.ts";

const DEFAULT_STORAGE_PATH = ".data/imaging";
export const MAX_IMAGING_OBJECT_BYTES = 64 * 1024 * 1024; // 64 MB per object

export function getStorageBase(): string {
  return (
    process.env.REPROCARE_IMAGING_STORAGE_DIR ||
    process.env.IMAGING_STORAGE_PATH ||
    DEFAULT_STORAGE_PATH
  );
}

export type ImagingArtifactKind =
  | "dicom"
  | "mask"
  | "mesh"
  | "volume"
  | "report"
  | "clinical_report"
  | "dicom_instance"
  | "dicom_series"
  | "segmentation_mask"
  | "mesh_3d";
export type CanonicalArtifactKind = "dicom" | "mask" | "mesh" | "volume" | "report";
export type ImagingObjectStatus = "active" | "archived" | "purged" | "corrupted" | "missing";

const KIND_ALIAS_MAP: Record<string, CanonicalArtifactKind> = {
  dicom: "dicom",
  dicom_instance: "dicom",
  dicom_series: "dicom",
  mask: "mask",
  segmentation_mask: "mask",
  mesh: "mesh",
  mesh_3d: "mesh",
  volume: "volume",
  report: "report",
  clinical_report: "report",
};

function normalizeKind(kind: string): CanonicalArtifactKind {
  const mapped = KIND_ALIAS_MAP[kind];
  if (!mapped) {
    throw new Error(`Invalid imaging artifact kind '${String(kind)}'.`);
  }
  return mapped;
}

/**
 * Validates that an identifier is a non-empty string free of path traversal or control characters.
 */
function validateSafeId(rawId: unknown, fieldName: string): string {
  if (typeof rawId !== "string") {
    throw new Error(`Unauthorized: Invalid or missing ${fieldName}.`);
  }
  const trimmed = rawId.trim();
  if (
    !trimmed ||
    trimmed.length > 128 ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error(`Unauthorized: Invalid or manipulated ${fieldName}.`);
  }
  return trimmed;
}

const SENSITIVE_METADATA_KEY_RE =
  /(?:password|secret|token|api[_-]?key|authorization|connection[_-]?string|private[_-]?key|database[_-]?url|storage[_-]?root|storage[_-]?path|patient[_-]?name|patient[_-]?birth|patient[_-]?address|patient[_-]?phone|patient[_-]?tel|ssn|aadhaar)/i;

/**
 * Strips credentials, storage paths, and direct PHI keys from user-supplied metadata objects.
 */
export function redactSensitiveMetadata(
  input: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SENSITIVE_METADATA_KEY_RE.test(k)) {
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      clean[k] = redactSensitiveMetadata(v as Record<string, unknown>);
    } else if (typeof v === "string") {
      // Redact any embedded bearer tokens or connection strings
      clean[k] = v
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[REDACTED_TOKEN]")
        .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_URI]");
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export interface DicomInstanceMetadata {
  sopClassUid?: string | null;
  sopInstanceUid?: string | null;
  studyInstanceUid?: string | null;
  seriesInstanceUid?: string | null;
  frameOfReferenceUid?: string | null;
  instanceNumber?: number | null;
  modality?: string | null;
  rows?: number | null;
  columns?: number | null;
  pixelSpacingMm?: [number, number] | null;
  sliceThicknessMm?: number | null;
  imagePositionPatient?: [number, number, number] | null;
  imageOrientationPatient?: number[] | null;
  transferSyntaxUid?: string | null;
  phiTagsScrubbed: string[];
}

export interface StoreArtifactInput {
  userId: string;
  patientId: string;
  studyId?: string | null;
  seriesId?: string | null;
  findingVersionId?: string | null;
  sourceObjectId?: string | null;
  sopInstanceUid?: string | null;
  instanceNumber?: number | null;
  kind: ImagingArtifactKind;
  filename?: string;
  fileName?: string | null;
  mimeType?: string | null;
  data: Uint8Array | Buffer;
  metadata?: Record<string, unknown>;
  retentionDays?: number;
  deduplicateIfIdentical?: boolean;
  forceNewVersion?: boolean;
}

export interface StoredArtifactRecord {
  id: string;
  userId: string;
  patientId: string;
  studyId: string | null;
  seriesId: string | null;
  findingVersionId: string | null;
  sourceObjectId: string | null;
  sopInstanceUid: string | null;
  instanceNumber: number | null;
  kind: ImagingArtifactKind;
  storageUri: string;
  storagePath: string;
  sha256: string;
  sha256Hash: string;
  bytes: number;
  study_id?: string | null;
  series_id?: string | null;
  sop_instance_uid?: string | null;
  instance_number?: number | null;
  version: number;
  mimeType: string;
  originalFilename: string;
  metadataJson: string;
  status: ImagingObjectStatus;
  createdBy: string;
  retentionUntil: string | null;
  createdAt: string;
  updatedAt: string;
  purgedAt: string | null;
  deduplicated?: boolean;
}

export interface ObjectIntegrityReport {
  objectId: string;
  exists: boolean;
  status: ImagingObjectStatus;
  expectedSha256: string;
  actualSha256: string | null;
  expectedBytes: number;
  actualBytes: number | null;
  integrityOk: boolean;
  valid: boolean;
  error: string | null;
}

export interface HistoricalFindingImagingEvidence {
  patientId: string;
  findingId: string;
  findingCode: string;
  structure: string;
  organ: string;
  findingVersion: {
    id: string;
    versionNo: number;
    previousVersionId: string | null;
    studyId: string;
    seriesId: string | null;
    observedOn: string;
    locationLabel: string;
    figo: string | null;
    centroidMm: [number, number, number] | null;
    axesMm: [number, number, number] | null;
    longestMm: number | null;
    volumeMm3: number | null;
    uncertaintyMm3: number | null;
    frame: string;
    segmentationSource: string;
    modelId: string | null;
    segmentationRunId: string | null;
    quality: string;
    modality: string;
    changeReason: string;
    createdAt: string;
  };
  study: {
    id: string;
    modality: string;
    studyDate: string;
    description: string;
    accession: string;
    studyInstanceUid: string | null;
  } | null;
  series: {
    id: string;
    seriesNumber: number;
    description: string;
    plane: string | null;
    sliceThicknessMm: number | null;
    pixelSpacingMm: string | null;
    sliceCount: number | null;
    seriesInstanceUid: string | null;
    frameOfReferenceUid: string | null;
    geometryJson: string | null;
    volumeSha256: string | null;
  } | null;
  segmentationRun: {
    id: string;
    modelId: string;
    weightsSha256: string | null;
    paramsJson: string;
    maskObjectId: string | null;
    labelCounts: string;
    volumeMm3: number | null;
    status: string;
    createdAt: string;
  } | null;
  sourceDicomObjects: Array<{
    record: StoredArtifactRecord;
    integrity: ObjectIntegrityReport;
    data?: Buffer;
  }>;
  maskObjects: Array<{
    record: StoredArtifactRecord;
    integrity: ObjectIntegrityReport;
    data?: Buffer;
  }>;
  meshObjects: Array<{
    record: StoredArtifactRecord;
    integrity: ObjectIntegrityReport;
    data?: Buffer;
  }>;
  evidenceLinks: Array<{
    id: string;
    kind: string;
    studyId: string | null;
    seriesId: string | null;
    imagingObjectId: string | null;
    maskObjectId: string | null;
    sliceIndex: number | null;
    note: string;
  }>;
  clinicianReviews: Array<{
    id: string;
    userId: string;
    status: string;
    note: string;
    createdAt: string;
  }>;
}

/**
 * Direct PHI tags (Group 0x0010 and identifying Group 0x0008/0x0020 tags) that must be
 * scrubbed from DICOM Part-10 files before persistent storage.
 */
const PHI_TAGS_TO_SCRUB = new Set<string>([
  "0008,0050", // AccessionNumber
  "0008,0080", // InstitutionName
  "0008,0081", // InstitutionAddress
  "0008,0090", // ReferringPhysicianName
  "0008,1048", // PhysiciansOfRecord
  "0008,1050", // PerformingPhysicianName
  "0008,1070", // OperatorsName
  "0010,0010", // PatientName
  "0010,0020", // PatientID
  "0010,0030", // PatientBirthDate
  "0010,0040", // PatientSex
  "0010,1000", // OtherPatientIDs
  "0010,1001", // OtherPatientNames
  "0010,1010", // PatientAge
  "0010,1040", // PatientAddress
  "0010,2154", // PatientTelephoneNumbers
]);

const LONG_VRS = new Set(["OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UR", "UT", "UN"]);

function tagKey(group: number, elem: number): string {
  return `${group.toString(16).padStart(4, "0").toLowerCase()},${elem.toString(16).padStart(4, "0").toLowerCase()}`;
}

/**
 * Validates that a buffer is a well-formed NEMA PS3.10 DICOM file, extracts non-identifying
 * spatial/instance metadata, and zeroes/scrubs any populated PHI tags in-place on a copy.
 */
export function validateAndScrubDicomBuffer(raw: Uint8Array | Buffer): {
  scrubbedBytes: Buffer;
  metadata: DicomInstanceMetadata;
} {
  if (!raw || raw.byteLength < 140) {
    throw new Error("Invalid DICOM upload: file is too small to be a valid DICOM Part-10 object (<140 bytes).");
  }
  const magic = String.fromCharCode(raw[128], raw[129], raw[130], raw[131]);
  if (magic !== "DICM") {
    throw new Error("Invalid DICOM upload: missing 'DICM' Part-10 preamble magic at offset 128.");
  }

  const out = Buffer.from(raw);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let offset = 132;
  const n = out.byteLength;

  const metadata: DicomInstanceMetadata = {
    phiTagsScrubbed: [],
  };

  while (offset + 8 <= n) {
    const group = view.getUint16(offset, true);
    const elem = view.getUint16(offset + 2, true);
    const vr = String.fromCharCode(out[offset + 4], out[offset + 5]);

    let length = 0;
    let valOffset = 0;
    const isExplicitUpper = vr >= "AA" && vr <= "ZZ" && /^[A-Z]{2}$/.test(vr);

    if (isExplicitUpper && LONG_VRS.has(vr)) {
      if (offset + 12 > n) break;
      length = view.getUint32(offset + 8, true);
      valOffset = offset + 12;
    } else if (isExplicitUpper) {
      length = view.getUint16(offset + 6, true);
      valOffset = offset + 8;
    } else {
      length = view.getUint32(offset + 4, true);
      valOffset = offset + 8;
    }

    if (length === 0xffffffff || valOffset + length > n) {
      break;
    }

    if (group === 0x7fe0 && elem === 0x0010) {
      // Reached PixelData
      break;
    }

    const key = tagKey(group, elem);
    const rawStr = out
      .subarray(valOffset, valOffset + length)
      .toString("utf8")
      .replace(/\0/g, "")
      .trim();

    if (PHI_TAGS_TO_SCRUB.has(key)) {
      if (rawStr.length > 0 && !/^0+$/.test(rawStr) && rawStr.toLowerCase() !== "anonymous") {
        metadata.phiTagsScrubbed.push(key);
      }
      // Overwrite PHI value bytes in the stored copy with spaces (or null for UI)
      const fillByte = vr === "UI" ? 0x00 : 0x20;
      out.fill(fillByte, valOffset, valOffset + length);
    } else {
      if (key === "0002,0010") metadata.transferSyntaxUid = rawStr;
      else if (key === "0008,0016") metadata.sopClassUid = rawStr;
      else if (key === "0008,0018") metadata.sopInstanceUid = rawStr;
      else if (key === "0008,0060") metadata.modality = rawStr;
      else if (key === "0020,000d") metadata.studyInstanceUid = rawStr;
      else if (key === "0020,000e") metadata.seriesInstanceUid = rawStr;
      else if (key === "0020,0013") {
        const num = Number.parseInt(rawStr, 10);
        if (Number.isFinite(num)) metadata.instanceNumber = num;
      } else if (key === "0020,0032") {
        const parts = rawStr.split("\\").map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite)) {
          metadata.imagePositionPatient = [parts[0], parts[1], parts[2]];
        }
      } else if (key === "0020,0037") {
        const parts = rawStr.split("\\").map(Number);
        if (parts.length === 6 && parts.every(Number.isFinite)) {
          metadata.imageOrientationPatient = parts;
        }
      } else if (key === "0020,0052") metadata.frameOfReferenceUid = rawStr;
      else if (key === "0018,0050") {
        const st = Number.parseFloat(rawStr);
        if (Number.isFinite(st) && st > 0) metadata.sliceThicknessMm = st;
      } else if (key === "0028,0010" && length === 2) {
        metadata.rows = view.getUint16(valOffset, true);
      } else if (key === "0028,0011" && length === 2) {
        metadata.columns = view.getUint16(valOffset, true);
      } else if (key === "0028,0030") {
        const parts = rawStr.split("\\").map(Number);
        if (parts.length === 2 && parts.every((v) => Number.isFinite(v) && v > 0)) {
          metadata.pixelSpacingMm = [parts[0], parts[1]];
        }
      }
    }

    offset = valOffset + length;
  }

  return { scrubbedBytes: out, metadata };
}

function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "artifact.bin";
  // Strip any potential patient name prefix and restrict characters
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact.bin";
}

export interface DurableAuditOutboxEntry {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  detail: string;
  createdAt: string;
  dbPersisted: boolean;
  entrySha256: string;
}

/**
 * Writes an audit event to PostgreSQL `audit_events` AND to a durable append-only server-side
 * audit outbox (`<storageBase>/.audit/audit-outbox.jsonl`). If the database insert fails, the
 * event is persisted to `<storageBase>/.audit/pending-outbox.jsonl` so critical security,
 * consent, clinician-verification, and imaging-deletion audit events never silently disappear.
 */
export async function writeAuditEvent(
  sql: Sql,
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  detail: string,
): Promise<DurableAuditOutboxEntry> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeDetail = redactSensitiveMetadata({ detail }).detail as string;
  const payloadForHash = JSON.stringify({ id, userId, action, entityType, entityId, detail: safeDetail, createdAt });
  const entrySha256 = createHash("sha256").update(payloadForHash).digest("hex");

  let dbPersisted = false;
  try {
    await sql`
      insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
      values (${id}, ${userId}, ${action}, ${entityType}, ${entityId}, ${safeDetail})
    `;
    dbPersisted = true;
  } catch {
    dbPersisted = false;
  }

  const entry: DurableAuditOutboxEntry = {
    id,
    userId,
    action,
    entityType,
    entityId,
    detail: safeDetail,
    createdAt,
    dbPersisted,
    entrySha256,
  };

  try {
    const auditDir = resolve(getStorageBase(), ".audit");
    await mkdir(auditDir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await appendFile(join(auditDir, "audit-outbox.jsonl"), line, "utf8");
    if (!dbPersisted) {
      await appendFile(join(auditDir, "pending-outbox.jsonl"), line, "utf8");
    }
  } catch {
    // If both DB and local disk outbox fail on a critical security/deletion event, fail closed
    if (!dbPersisted && /purge|delete|consent|verif|deidentify/i.test(action)) {
      throw new Error("Audit persistence failure: unable to record critical security event to database or durable outbox.");
    }
  }

  return entry;
}

/**
 * Replays any pending durable audit outbox entries (`pending-outbox.jsonl`) into PostgreSQL
 * `audit_events` after a transient database failure, clearing replayed entries once committed.
 */
export async function flushPendingAuditOutbox(
  sql: Sql,
): Promise<{ replayedCount: number; remainingCount: number }> {
  const auditDir = resolve(getStorageBase(), ".audit");
  const pendingPath = join(auditDir, "pending-outbox.jsonl");
  let raw = "";
  try {
    raw = await readFile(pendingPath, "utf8");
  } catch {
    return { replayedCount: 0, remainingCount: 0 };
  }

  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { replayedCount: 0, remainingCount: 0 };
  }

  const remaining: string[] = [];
  let replayedCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as DurableAuditOutboxEntry;
      await sql`
        insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
        values (${entry.id}, ${entry.userId}, ${entry.action}, ${entry.entityType}, ${entry.entityId}, ${entry.detail})
        on conflict (id) do nothing
      `;
      replayedCount += 1;
    } catch {
      remaining.push(line);
    }
  }

  await writeFile(
    pendingPath,
    remaining.length > 0 ? remaining.join("\n") + "\n" : "",
    "utf8",
  );
  return { replayedCount, remainingCount: remaining.length };
}

/**
 * Reads all durable audit outbox records stored in `<storageBase>/.audit/audit-outbox.jsonl`.
 */
export async function readDurableAuditOutbox(): Promise<DurableAuditOutboxEntry[]> {
  const outboxPath = resolve(getStorageBase(), ".audit", "audit-outbox.jsonl");
  try {
    const raw = await readFile(outboxPath, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DurableAuditOutboxEntry);
  } catch {
    return [];
  }
}

/**
 * Verifies that `userId` is authenticated and has an existing row in `profiles` before
 * any imaging object lookup is performed. Fails closed on missing profile or DB query error.
 */
async function verifyCallerIdentityAndProfile(
  sql: Sql,
  userId: string,
): Promise<{ uid: string; role: string; canActAsClinician: boolean; isVerifiedClinician: boolean }> {
  const uid = validateSafeId(userId, "userId");

  let profileRows: Array<{ role: string }>;
  try {
    profileRows = await sql<{ role: string }>`
      select role from profiles where user_id = ${uid}
    `;
  } catch {
    throw new Error("Unauthorized: Database query failed while verifying user profile; failing closed.");
  }

  if (!Array.isArray(profileRows) || profileRows.length === 0 || !profileRows[0]?.role) {
    throw new Error("Unauthorized: User profile not found; access denied.");
  }

  const role = String(profileRows[0].role);
  if (role !== "patient" && role !== "clinician" && role !== "admin") {
    throw new Error("Unauthorized: Unrecognized user profile role; access denied.");
  }

  let isVerifiedClinician = false;
  if (role === "clinician") {
    let verifRows: Array<{ status: string; licence_no: string; registry: string }>;
    try {
      verifRows = await sql<{ status: string; licence_no: string; registry: string }>`
        select status, licence_no, registry
        from clinician_verifications
        where user_id = ${uid}
        order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
        limit 1
      `;
    } catch {
      throw new Error(
        "Unauthorized: Database query failed while verifying clinician credentials; failing closed.",
      );
    }
    const v = verifRows[0];
    isVerifiedClinician =
      Boolean(v) &&
      (v.status === "verified" || v.status === "approved") &&
      String(v.licence_no ?? "").trim().length > 0 &&
      String(v.registry ?? "").trim().length > 0;
  }

  const canActAsClinician = role === "admin" || (role === "clinician" && isVerifiedClinician);
  return { uid, role, canActAsClinician, isVerifiedClinician };
}

/**
 * Authoritative fail-closed access control check for all imaging storage operations.
 *
 * Enforces:
 * 1. Authenticated user identity and existing profile in `profiles` (missing profile is NEVER allowed).
 * 2. Database errors during profile, patient, clinician verification, or consent queries NEVER fail open.
 * 3. Clinicians must hold an approved verification record (`verified` or `approved`); unverified,
 *    pending, rejected, suspended, or revoked clinicians are denied immediately.
 * 4. Cross-user access (`patient.user_id !== uid`) is permitted ONLY for a verified clinician with an
 *    active, non-expired, non-revoked consent in `patient_clinician_consents` granting `'view_imaging'`
 *    (and `'add_annotations'` or `'review_ai_findings'` when `requireClinicianForMutation === true`).
 * 5. Patients may only read/list/verify their own (`patient.user_id === uid && patient.is_self === true`)
 *    imaging objects and may never upload or purge clinical imaging artifacts.
 */
export async function checkPatientAndClinicianAccess(
  sql: Sql,
  userId: string,
  patientId: string,
  requireClinicianForMutation: boolean,
): Promise<{ patientOwnerUserId: string; callerRole: string; isVerifiedClinician: boolean }> {
  const { uid, role, canActAsClinician, isVerifiedClinician } =
    await verifyCallerIdentityAndProfile(sql, userId);
  const pid = validateSafeId(patientId, "patientId");

  // If caller has role='clinician' but is not verified/approved, block clinician operations immediately
  if (role === "clinician" && !isVerifiedClinician) {
    throw new Error(
      "Unauthorized: Clinician verification is not approved. Unverified, pending, suspended, or revoked clinicians cannot access imaging storage.",
    );
  }

  let allPatientRows: Array<{ id: string; user_id: string; is_self: boolean }>;
  try {
    allPatientRows = await sql<{ id: string; user_id: string; is_self: boolean }>`
      select id, user_id, is_self from patients where id = ${pid}
    `;
  } catch {
    throw new Error("Unauthorized: Database query failed while verifying patient ownership; failing closed.");
  }

  const patient = allPatientRows[0];
  if (!patient) {
    throw new Error("Record not found or access denied.");
  }

  const patientOwnerUserId = String(patient.user_id);

  if (patientOwnerUserId !== uid) {
    // Cross-user access: strictly restricted to a verified clinician with active consent
    if (!isVerifiedClinician || role === "admin") {
      throw new Error("Unauthorized: Record not found or access denied.");
    }

    let consentRows: Array<{
      id: string;
      status: string;
      permissions_json: string;
      expires_at: string | null;
      revoked_at: string | null;
    }>;
    try {
      consentRows = await sql<{
        id: string;
        status: string;
        permissions_json: string;
        expires_at: string | null;
        revoked_at: string | null;
      }>`
        select id, status, permissions_json, expires_at, revoked_at
        from patient_clinician_consents
        where patient_id = ${pid} and clinician_user_id = ${uid}
        order by granted_at desc
        limit 1
      `;
    } catch {
      throw new Error("Unauthorized: Database query failed while verifying patient consent; failing closed.");
    }

    const c = consentRows[0];
    const expired = c?.expires_at ? Date.parse(c.expires_at) <= Date.now() : false;
    if (!c || c.status !== "active" || Boolean(c.revoked_at) || expired) {
      throw new Error("Unauthorized: Record not found or access denied (no active patient consent).");
    }

    let perms: string[] = [];
    try {
      const parsed = JSON.parse(c.permissions_json || "[]");
      if (Array.isArray(parsed)) {
        perms = parsed.filter((p): p is string => typeof p === "string");
      }
    } catch {
      perms = [];
    }

    if (!perms.includes("view_imaging")) {
      throw new Error("Unauthorized: Active patient consent does not grant 'view_imaging' permission.");
    }
    if (
      requireClinicianForMutation &&
      !perms.includes("add_annotations") &&
      !perms.includes("review_ai_findings")
    ) {
      throw new Error(
        "Unauthorized: Active patient consent does not grant 'add_annotations' or 'review_ai_findings' permission required to upload or modify imaging artifacts.",
      );
    }

    return { patientOwnerUserId, callerRole: role, isVerifiedClinician };
  }

  // Same-user access (`patientOwnerUserId === uid`)
  if (requireClinicianForMutation && !canActAsClinician) {
    throw new Error(
      "Unauthorized: Storing or modifying clinical imaging artifacts requires verified clinician credentials.",
    );
  }
  if (!canActAsClinician && !patient.is_self) {
    throw new Error("Unauthorized: Patient accounts can access only their own imaging records.");
  }

  return { patientOwnerUserId, callerRole: role, isVerifiedClinician };
}

function mapArtifactRow(r: Record<string, unknown>): StoredArtifactRecord {
  const relUri = String(r.storageUri ?? r.storage_uri ?? "");
  const fullPath = relUri.startsWith("/") ? relUri : resolve(resolve(getStorageBase()), relUri);
  const sha = String(r.sha256 ?? "");
  const studyId = (r.studyId ?? r.study_id ?? null) as string | null;
  const seriesId = (r.seriesId ?? r.series_id ?? null) as string | null;
  const sopInstanceUid = (r.sopInstanceUid ?? r.sop_instance_uid ?? null) as string | null;
  const instanceNumber =
    r.instanceNumber != null || r.instance_number != null
      ? Number(r.instanceNumber ?? r.instance_number)
      : null;
  return {
    id: String(r.id),
    userId: String(r.userId ?? r.user_id),
    patientId: String(r.patientId ?? r.patient_id),
    studyId,
    seriesId,
    findingVersionId: (r.findingVersionId ?? r.finding_version_id ?? null) as string | null,
    sourceObjectId: (r.sourceObjectId ?? r.source_object_id ?? null) as string | null,
    sopInstanceUid,
    instanceNumber,
    study_id: studyId,
    series_id: seriesId,
    sop_instance_uid: sopInstanceUid,
    instance_number: instanceNumber,
    kind: (r.kind as ImagingArtifactKind) ?? "dicom",
    storageUri: fullPath,
    storagePath: fullPath,
    sha256: sha,
    sha256Hash: sha,
    bytes: Number(r.bytes ?? 0),
    version: Number(r.version ?? 1),
    mimeType: String(r.mimeType ?? r.mime_type ?? "application/octet-stream"),
    originalFilename: String(r.originalFilename ?? r.original_filename ?? ""),
    metadataJson: String(r.metadataJson ?? r.metadata_json ?? "{}"),
    status: ((r.status as ImagingObjectStatus) ?? "active"),
    createdBy: String(r.createdBy ?? r.created_by),
    retentionUntil: (r.retentionUntil ?? r.retention_until ?? null) as string | null,
    createdAt: String(r.createdAt ?? r.created_at ?? ""),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? r.createdAt ?? r.created_at ?? ""),
    purgedAt: (r.purgedAt ?? r.purged_at ?? null) as string | null,
  };
}

/**
 * Stores an imaging artifact securely to persistent disk and records its provenance in imaging_objects.
 *
 * Enforces:
 * - Fail-closed authorization (`checkPatientAndClinicianAccess` with `requireClinicianForMutation = true`).
 * - Cross-patient ID ownership verification for `studyId`, `seriesId`, `findingVersionId`, and `sourceObjectId`.
 * - Upload validation (size, kind, and DICOM Part-10 format + PHI scrubbing when kind === 'dicom').
 * - Duplicate detection (returns existing active record with `deduplicated: true` if identical SHA-256 exists
 *   for the same patient, series, and kind, unless `forceNewVersion` is true).
 * - Monotonic versioning (`version = max + 1`) and unique storage URI so existing files are NEVER overwritten silently.
 */
export async function storeImagingArtifact(
  sql: Sql,
  input: StoreArtifactInput,
): Promise<StoredArtifactRecord> {
  const { patientOwnerUserId } = await checkPatientAndClinicianAccess(
    sql,
    input.userId,
    input.patientId,
    true,
  );
  const actorUserId = validateSafeId(input.userId, "userId");
  const patientId = validateSafeId(input.patientId, "patientId");

  const canonicalKind = normalizeKind(input.kind);
  if (!input.data || input.data.byteLength === 0) {
    throw new Error("Invalid imaging upload: payload is empty (0 bytes).");
  }
  if (input.data.byteLength > MAX_IMAGING_OBJECT_BYTES) {
    throw new Error(
      `Invalid imaging upload: payload (${input.data.byteLength} bytes) exceeds maximum allowed limit (${MAX_IMAGING_OBJECT_BYTES} bytes).`,
    );
  }

  // Validate manipulated cross-patient IDs before writing anything to disk
  let resolvedStudyId: string | null = input.studyId ? validateSafeId(input.studyId, "studyId") : null;
  const requestedSeriesId: string | null = input.seriesId ? validateSafeId(input.seriesId, "seriesId") : null;
  const requestedFvId: string | null = input.findingVersionId
    ? validateSafeId(input.findingVersionId, "findingVersionId")
    : null;
  const requestedSourceObjId: string | null = input.sourceObjectId
    ? validateSafeId(input.sourceObjectId, "sourceObjectId")
    : null;

  if (resolvedStudyId) {
    let stRows: Array<{ id: string; patient_id: string }>;
    try {
      stRows = await sql<{ id: string; patient_id: string }>`
        select id, patient_id from studies where id = ${resolvedStudyId}
      `;
    } catch {
      throw new Error("Unauthorized: Database error while validating study ownership; failing closed.");
    }
    if (!stRows[0] || String(stRows[0].patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient studyId.");
    }
  }

  if (requestedSeriesId) {
    let srRows: Array<{ id: string; study_id: string; patient_id: string }>;
    try {
      srRows = await sql<{ id: string; study_id: string; patient_id: string }>`
        select s.id, s.study_id, st.patient_id
        from series s
        join studies st on st.id = s.study_id
        where s.id = ${requestedSeriesId}
      `;
    } catch {
      throw new Error("Unauthorized: Database error while validating series ownership; failing closed.");
    }
    const sr = srRows[0];
    if (!sr || String(sr.patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient seriesId.");
    }
    if (resolvedStudyId && String(sr.study_id) !== resolvedStudyId) {
      throw new Error("Unauthorized: seriesId does not belong to the specified studyId.");
    }
    resolvedStudyId = resolvedStudyId ?? String(sr.study_id);
  }

  if (requestedFvId) {
    let fvRows: Array<{ id: string; patient_id: string }>;
    try {
      fvRows = await sql<{ id: string; patient_id: string }>`
        select fv.id, f.patient_id
        from finding_versions fv
        join findings f on f.id = fv.finding_id
        where fv.id = ${requestedFvId}
      `;
    } catch {
      throw new Error("Unauthorized: Database error while validating findingVersionId; failing closed.");
    }
    if (!fvRows[0] || String(fvRows[0].patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient findingVersionId.");
    }
  }

  if (requestedSourceObjId) {
    let srcRows: Array<{ id: string; patient_id: string }>;
    try {
      srcRows = await sql<{ id: string; patient_id: string }>`
        select id, patient_id from imaging_objects where id = ${requestedSourceObjId}
      `;
    } catch {
      throw new Error("Unauthorized: Database error while validating sourceObjectId; failing closed.");
    }
    if (!srcRows[0] || String(srcRows[0].patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient sourceObjectId.");
    }
  }

  let payloadToStore: Buffer = Buffer.from(input.data);
  let extractedDicomMeta: DicomInstanceMetadata | null = null;
  const rawName = input.filename || input.fileName || `${canonicalKind}.bin`;

  if (canonicalKind === "dicom") {
    if (
      payloadToStore.byteLength >= 132 &&
      payloadToStore.subarray(128, 132).toString("ascii") === "DICM"
    ) {
      const validated = validateAndScrubDicomBuffer(payloadToStore);
      payloadToStore = validated.scrubbedBytes;
      extractedDicomMeta = validated.metadata;
    } else if (
      input.kind === "dicom_instance" ||
      input.kind === "dicom_series" ||
      rawName.toLowerCase().endsWith(".dcm")
    ) {
      throw new Error(
        "Invalid DICOM file: missing NEMA PS3.10 'DICM' header preamble at offset 128.",
      );
    }
  }

  const hash = createHash("sha256").update(payloadToStore).digest("hex");
  const safeFilename = sanitizeFilename(rawName);
  const defaultMime =
    canonicalKind === "dicom"
      ? "application/dicom"
      : canonicalKind === "mask"
        ? "application/octet-stream"
        : canonicalKind === "mesh"
          ? "model/stl"
          : "application/octet-stream";
  const mimeType = input.mimeType ?? defaultMime;

  // Check for existing objects in this series/patient/kind for duplicate detection & monotonic versioning
  let existingRows: Array<Record<string, unknown>>;
  try {
    existingRows = await sql<Record<string, unknown>>`
      select *
      from imaging_objects
      where patient_id = ${patientId}
        and kind = ${canonicalKind}
        and coalesce(series_id, '') = ${requestedSeriesId ?? ""}
      order by version desc, created_at desc
    `;
  } catch {
    throw new Error("Unauthorized: Database error while checking existing imaging versions; failing closed.");
  }

  const deduplicate = input.deduplicateIfIdentical !== false && !input.forceNewVersion;
  if (deduplicate) {
    const exactMatch = existingRows.find(
      (r) => String(r.sha256) === hash && (r.status == null || r.status === "active"),
    );
    if (exactMatch) {
      const mapped = mapArtifactRow(exactMatch);
      return { ...mapped, deduplicated: true };
    }
  }

  const maxVersion = existingRows.reduce((maxV, r) => Math.max(maxV, Number(r.version ?? 1)), 0);
  const nextVersion = maxVersion + 1;

  const id = crypto.randomUUID();
  const base = resolve(getStorageBase());
  const safeOwner = patientOwnerUserId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safePatient = patientId.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Versioned, content-addressed path guarantees original imaging is never silently overwritten
  const relativePath = join(
    safeOwner,
    safePatient,
    canonicalKind,
    `v${nextVersion}_${hash}_${id.slice(0, 8)}.bin`,
  );
  const fullPath = resolve(base, relativePath);
  if (!fullPath.startsWith(base)) {
    throw new Error("Security violation: resolved storage path escaped storage root.");
  }

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, payloadToStore, { flag: "wx" });

  let retentionUntil: Date | null = null;
  if (input.retentionDays && input.retentionDays > 0) {
    retentionUntil = new Date(Date.now() + input.retentionDays * 86400 * 1000);
  }

  const sopUid = input.sopInstanceUid ?? extractedDicomMeta?.sopInstanceUid ?? null;
  const instNum = input.instanceNumber ?? extractedDicomMeta?.instanceNumber ?? null;
  const sanitizedCustomMeta = redactSensitiveMetadata(input.metadata);
  const combinedMeta = {
    ...(extractedDicomMeta ? { dicom: extractedDicomMeta } : {}),
    ...sanitizedCustomMeta,
    artifactKind: canonicalKind,
    deidentified: true,
  };
  const metaJsonStr = JSON.stringify(combinedMeta);

  let insertedRow: Record<string, unknown> | undefined;
  try {
    const rows = await sql<Record<string, unknown>>`
      insert into imaging_objects (
        id, user_id, patient_id, study_id, series_id, finding_version_id, source_object_id,
        sop_instance_uid, instance_number, kind, storage_uri, sha256, bytes, version,
        mime_type, original_filename, metadata_json, status, created_by, retention_until
      ) values (
        ${id}, ${patientOwnerUserId}, ${patientId}, ${resolvedStudyId}, ${requestedSeriesId},
        ${requestedFvId}, ${requestedSourceObjId},
        ${sopUid}, ${instNum}, ${canonicalKind}, ${relativePath}, ${hash}, ${payloadToStore.byteLength},
        ${nextVersion}, ${mimeType}, ${safeFilename}, ${metaJsonStr}, 'active',
        ${actorUserId}, ${retentionUntil?.toISOString() ?? null}
      )
      returning *
    `;
    insertedRow = rows[0];
  } catch {
    const dbCompatKind =
      canonicalKind === "dicom" ||
      canonicalKind === "mask" ||
      canonicalKind === "mesh" ||
      canonicalKind === "volume"
        ? canonicalKind
        : "volume";
    try {
      const rows = await sql<Record<string, unknown>>`
        insert into imaging_objects (
          id, user_id, patient_id, study_id, series_id, finding_version_id, source_object_id,
          sop_instance_uid, instance_number, kind, storage_uri, sha256, bytes, version,
          mime_type, original_filename, metadata_json, status, created_by, retention_until
        ) values (
          ${id}, ${patientOwnerUserId}, ${patientId}, ${resolvedStudyId}, ${requestedSeriesId},
          ${requestedFvId}, ${requestedSourceObjId},
          ${sopUid}, ${instNum}, ${dbCompatKind}, ${relativePath}, ${hash}, ${payloadToStore.byteLength},
          ${nextVersion}, ${mimeType}, ${safeFilename}, ${metaJsonStr}, 'active',
          ${actorUserId}, ${retentionUntil?.toISOString() ?? null}
        )
        returning *
      `;
      insertedRow = rows[0] ? { ...rows[0], kind: canonicalKind } : undefined;
    } catch {
      const rows = await sql<Record<string, unknown>>`
        insert into imaging_objects (
          id, user_id, patient_id, series_id, kind, storage_uri, sha256, bytes, version, created_by, retention_until
        ) values (
          ${id}, ${patientOwnerUserId}, ${patientId}, ${requestedSeriesId},
          ${dbCompatKind}, ${relativePath}, ${hash}, ${payloadToStore.byteLength}, ${nextVersion},
          ${actorUserId}, ${retentionUntil?.toISOString() ?? null}
        )
        returning *
      `;
      insertedRow = rows[0] ? { ...rows[0], kind: canonicalKind } : undefined;
    }
  }

  await writeAuditEvent(
    sql,
    actorUserId,
    "store_imaging_object",
    "imaging_object",
    id,
    `Stored ${canonicalKind} v${nextVersion} (${payloadToStore.byteLength} bytes, sha256 ${hash.slice(0, 12)}…) for patient ${patientId}${requestedSeriesId ? `, series ${requestedSeriesId}` : ""}.`,
  );

  return {
    ...mapArtifactRow(
      insertedRow ?? {
        id,
        user_id: patientOwnerUserId,
        patient_id: patientId,
        study_id: resolvedStudyId,
        series_id: requestedSeriesId,
        finding_version_id: requestedFvId,
        source_object_id: requestedSourceObjId,
        sop_instance_uid: sopUid,
        instance_number: instNum,
        kind: canonicalKind,
        storage_uri: relativePath,
        sha256: hash,
        bytes: payloadToStore.byteLength,
        version: nextVersion,
        mime_type: mimeType,
        original_filename: safeFilename,
        metadata_json: metaJsonStr,
        status: "active",
        created_by: actorUserId,
        retention_until: retentionUntil?.toISOString() ?? null,
        created_at: new Date().toISOString(),
      },
    ),
    deduplicated: false,
  };
}

/**
 * Verifies the on-disk existence, byte size, and SHA-256 checksum of a stored imaging object
 * after strictly enforcing caller identity, profile, patient ownership, and consent checks.
 */
export async function verifyImagingObjectIntegrity(
  sql: Sql,
  userId: string,
  objectId: string,
): Promise<ObjectIntegrityReport> {
  await verifyCallerIdentityAndProfile(sql, userId);
  const safeObjectId = validateSafeId(objectId, "objectId");

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await sql<Record<string, unknown>>`
      select * from imaging_objects where id = ${safeObjectId}
    `;
  } catch {
    throw new Error("Unauthorized: Database query failed while loading imaging object; failing closed.");
  }

  if (rows.length === 0) {
    throw new Error("Imaging object not found or access denied.");
  }
  const record = mapArtifactRow(rows[0]);
  await checkPatientAndClinicianAccess(sql, userId, record.patientId, false);

  if (record.status === "purged") {
    return {
      objectId: record.id,
      exists: false,
      status: "purged",
      expectedSha256: record.sha256,
      actualSha256: null,
      expectedBytes: record.bytes,
      actualBytes: null,
      integrityOk: false,
      valid: false,
      error: "Imaging object binary payload was purged under retention/deletion policy; metadata and audit record preserved.",
    };
  }

  const base = resolve(getStorageBase());
  const fullPath = resolve(base, record.storageUri);
  if (!fullPath.startsWith(base)) {
    return {
      objectId: record.id,
      exists: false,
      status: record.status,
      expectedSha256: record.sha256,
      actualSha256: null,
      expectedBytes: record.bytes,
      actualBytes: null,
      integrityOk: false,
      valid: false,
      error: "Invalid storage URI path.",
    };
  }

  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) {
      return {
        objectId: record.id,
        exists: false,
        status: record.status,
        expectedSha256: record.sha256,
        actualSha256: null,
        expectedBytes: record.bytes,
        actualBytes: null,
        integrityOk: false,
        valid: false,
        error: "Storage path is not a regular file.",
      };
    }
    const data = await readFile(fullPath);
    const actualSha256 = createHash("sha256").update(data).digest("hex");
    const sizeMatch = data.byteLength === record.bytes;
    const hashMatch = actualSha256 === record.sha256;
    const ok = sizeMatch && hashMatch;
    return {
      objectId: record.id,
      exists: true,
      status: ok ? ("ok" as unknown as ImagingObjectStatus) : "corrupted",
      expectedSha256: record.sha256,
      actualSha256,
      expectedBytes: record.bytes,
      actualBytes: data.byteLength,
      integrityOk: ok,
      valid: ok,
      error: ok
        ? null
        : !hashMatch
          ? `SHA-256 checksum mismatch (expected ${record.sha256.slice(0, 12)}…, got ${actualSha256.slice(0, 12)}…)`
          : `Byte size mismatch (expected ${record.bytes}, got ${data.byteLength})`,
    };
  } catch {
    return {
      objectId: record.id,
      exists: false,
      status: "missing",
      expectedSha256: record.sha256,
      actualSha256: null,
      expectedBytes: record.bytes,
      actualBytes: null,
      integrityOk: false,
      valid: false,
      error: `Missing storage object: binary file for artifact ${safeObjectId} is absent on disk.`,
    };
  }
}

/**
 * Retrieves an imaging artifact with strict fail-closed profile, patient ownership, clinician
 * verification, consent scope, existence, and SHA-256 integrity verification.
 */
export async function getImagingArtifact(
  sql: Sql,
  userId: string,
  objectId: string,
  includeData: boolean = true,
): Promise<{ record: StoredArtifactRecord; integrity: ObjectIntegrityReport; data?: Buffer }> {
  const { uid } = await verifyCallerIdentityAndProfile(sql, userId);
  const safeObjectId = validateSafeId(objectId, "objectId");

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await sql<Record<string, unknown>>`
      select * from imaging_objects where id = ${safeObjectId}
    `;
  } catch {
    throw new Error("Unauthorized: Database query failed while retrieving imaging object; failing closed.");
  }

  if (rows.length === 0) {
    throw new Error("Imaging object not found or access denied.");
  }

  const record = mapArtifactRow(rows[0]);
  await checkPatientAndClinicianAccess(sql, uid, record.patientId, false);

  if (record.status === "purged") {
    throw new Error(`Imaging object ${safeObjectId} has been purged under retention policy.`);
  }

  const base = resolve(getStorageBase());
  const fullPath = resolve(base, record.storageUri);
  if (!fullPath.startsWith(base)) {
    throw new Error("Security violation: invalid storage URI.");
  }

  let data: Buffer;
  try {
    data = await readFile(fullPath);
  } catch {
    await writeAuditEvent(
      sql,
      uid,
      "imaging_integrity_missing",
      "imaging_object",
      safeObjectId,
      `Missing storage blob detected when retrieving ${record.kind} object ${safeObjectId}.`,
    );
    throw new Error(
      `Missing storage object: binary payload for artifact ${safeObjectId} could not be found on disk.`,
    );
  }

  const actualHash = createHash("sha256").update(data).digest("hex");
  if (actualHash !== record.sha256) {
    await writeAuditEvent(
      sql,
      uid,
      "imaging_integrity_corrupted",
      "imaging_object",
      safeObjectId,
      `Checksum mismatch for object ${safeObjectId}: expected ${record.sha256}, actual ${actualHash}.`,
    );
    throw new Error(
      `Imaging object integrity verification failed for artifact ${safeObjectId}: SHA-256 hash mismatch.`,
    );
  }

  const integrity = await verifyImagingObjectIntegrity(sql, uid, safeObjectId);
  return { record, integrity, ...(includeData ? { data } : {}) };
}

export interface ListImagingArtifactsFilter {
  patientId: string;
  studyId?: string;
  seriesId?: string;
  findingVersionId?: string;
  kind?: ImagingArtifactKind;
  includePurged?: boolean;
}

/**
 * Lists stored imaging artifacts for a given series or patient after enforcing fail-closed
 * authorization and cross-patient filter validation.
 */
export async function listImagingArtifacts(
  sql: Sql,
  userId: string,
  patientIdOrFilter: string | ListImagingArtifactsFilter,
  seriesIdArg?: string,
): Promise<StoredArtifactRecord[]> {
  const filter: ListImagingArtifactsFilter =
    typeof patientIdOrFilter === "string"
      ? { patientId: patientIdOrFilter, ...(seriesIdArg ? { seriesId: seriesIdArg } : {}) }
      : patientIdOrFilter;

  const patientId = validateSafeId(filter?.patientId, "patientId");
  await checkPatientAndClinicianAccess(sql, userId, patientId, false);

  const seriesId = filter.seriesId ? validateSafeId(filter.seriesId, "seriesId") : undefined;
  const studyId = filter.studyId ? validateSafeId(filter.studyId, "studyId") : undefined;
  const findingVersionId = filter.findingVersionId
    ? validateSafeId(filter.findingVersionId, "findingVersionId")
    : undefined;
  const canonicalKind = filter.kind ? normalizeKind(filter.kind) : undefined;

  if (studyId) {
    const stRows = await sql<{ id: string; patient_id: string }>`
      select id, patient_id from studies where id = ${studyId}
    `;
    if (!stRows[0] || String(stRows[0].patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient studyId in imaging filter.");
    }
  }

  if (seriesId) {
    const srRows = await sql<{ id: string; patient_id: string }>`
      select s.id, st.patient_id
      from series s
      join studies st on st.id = s.study_id
      where s.id = ${seriesId}
    `;
    if (!srRows[0] || String(srRows[0].patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient seriesId in imaging filter.");
    }
  }

  if (findingVersionId) {
    const fvRows = await sql<{ id: string; patient_id: string }>`
      select fv.id, f.patient_id
      from finding_versions fv
      join findings f on f.id = fv.finding_id
      where fv.id = ${findingVersionId}
    `;
    if (!fvRows[0] || String(fvRows[0].patient_id) !== patientId) {
      throw new Error("Unauthorized: Invalid or cross-patient findingVersionId in imaging filter.");
    }
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = seriesId
      ? await sql<Record<string, unknown>>`
          select * from imaging_objects
          where patient_id = ${patientId} and series_id = ${seriesId}
          order by version desc, created_at desc
        `
      : await sql<Record<string, unknown>>`
          select * from imaging_objects
          where patient_id = ${patientId}
          order by version desc, created_at desc
        `;
  } catch {
    throw new Error("Unauthorized: Database query failed while listing imaging objects; failing closed.");
  }

  let mapped = rows.map(mapArtifactRow);
  if (studyId) {
    mapped = mapped.filter((r) => r.studyId === studyId);
  }
  if (findingVersionId) {
    mapped = mapped.filter((r) => r.findingVersionId === findingVersionId);
  }
  if (canonicalKind) {
    mapped = mapped.filter((r) => normalizeKind(r.kind) === canonicalKind);
  }
  if (filter.includePurged === false) {
    mapped = mapped.filter((r) => r.status !== "purged");
  }
  return mapped;
}

/**
 * Purges the binary file of an imaging object for retention/erasure compliance while preserving
 * the database provenance tombstone and recording an immutable audit event.
 */
export async function purgeImagingArtifact(
  sql: Sql,
  userId: string,
  objectId: string,
  reason: string,
): Promise<{ ok: true; objectId: string; status: "purged"; purged?: boolean }> {
  const { uid } = await verifyCallerIdentityAndProfile(sql, userId);
  const safeObjectId = validateSafeId(objectId, "objectId");
  const cleanReason = String(reason ?? "").trim();
  if (cleanReason.length < 4) {
    throw new Error("A retention or deletion reason (at least 4 characters) is required for auditing.");
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await sql<Record<string, unknown>>`
      select * from imaging_objects where id = ${safeObjectId}
    `;
  } catch {
    throw new Error("Unauthorized: Database query failed while locating imaging object for purge; failing closed.");
  }
  if (rows.length === 0) {
    throw new Error("Imaging object not found or access denied.");
  }
  const record = mapArtifactRow(rows[0]);
  await checkPatientAndClinicianAccess(sql, uid, record.patientId, true);

  const base = resolve(getStorageBase());
  const fullPath = resolve(base, record.storageUri);
  if (!fullPath.startsWith(base)) {
    throw new Error("Security violation: invalid storage URI.");
  }

  // Two-phase atomic purge: stage the binary file before updating DB status.
  // If the DB status update fails, restore the staged file so binary storage and DB status never diverge.
  const stagedPath = `${fullPath}.purging-${crypto.randomUUID().slice(0, 8)}`;
  let fileWasStaged = false;
  try {
    await rename(fullPath, stagedPath);
    fileWasStaged = true;
  } catch {
    fileWasStaged = false;
  }

  let dbUpdated = false;
  try {
    const updatedRows = await sql<{ id: string }>`
      update imaging_objects
      set status = 'purged', purged_at = now(), updated_at = now()
      where id = ${safeObjectId} and patient_id = ${record.patientId}
      returning id
    `;
    dbUpdated = updatedRows.length > 0;
  } catch {
    try {
      const fallbackRows = await sql<{ id: string }>`
        update imaging_objects
        set status = 'purged'
        where id = ${safeObjectId} and patient_id = ${record.patientId}
        returning id
      `;
      dbUpdated = fallbackRows.length > 0;
    } catch (dbErr) {
      if (fileWasStaged) {
        await rename(stagedPath, fullPath).catch(() => undefined);
      }
      throw new Error(
        `Atomic purge aborted: failed to update database status for imaging object ${safeObjectId}; binary file was preserved intact (${dbErr instanceof Error ? dbErr.message : "DB error"}).`,
      );
    }
  }

  if (!dbUpdated) {
    if (fileWasStaged) {
      await rename(stagedPath, fullPath).catch(() => undefined);
    }
    throw new Error(
      `Atomic purge aborted: imaging object ${safeObjectId} status could not be updated in database; binary file was preserved intact.`,
    );
  }

  if (fileWasStaged) {
    await unlink(stagedPath).catch(() => undefined);
  }

  await writeAuditEvent(
    sql,
    uid,
    "purge_imaging_object",
    "imaging_object",
    safeObjectId,
    `Purged binary payload for ${record.kind} object ${safeObjectId} (sha256 ${record.sha256.slice(0, 12)}…): ${cleanReason}`,
  );

  return { ok: true, purged: true, objectId: safeObjectId, status: "purged" };
}

/**
 * Retrieves the complete historical imaging evidence chain for a finding or specific finding version
 * (Patient -> Study -> Series -> Original DICOM Instances / Volume -> Segmentation Run -> Mask -> Mesh -> Reviews).
 * Enforces fail-closed authorization and verifies SHA-256 integrity on every linked storage object.
 */
export async function getHistoricalFindingImagingEvidence(
  sql: Sql,
  userId: string,
  optionsOrVersionId:
    | string
    | {
        findingId?: string;
        findingVersionId?: string;
        includeBinaryPayloads?: boolean;
      },
): Promise<any> {
  const { uid } = await verifyCallerIdentityAndProfile(sql, userId);
  const options =
    typeof optionsOrVersionId === "string"
      ? { findingVersionId: optionsOrVersionId }
      : optionsOrVersionId;
  if (!options?.findingId && !options?.findingVersionId) {
    throw new Error("Either findingId or findingVersionId must be provided.");
  }

  const safeVersionId = options.findingVersionId
    ? validateSafeId(options.findingVersionId, "findingVersionId")
    : undefined;
  const safeFindingId = options.findingId
    ? validateSafeId(options.findingId, "findingId")
    : undefined;

  let vRows: Array<Record<string, unknown>>;
  try {
    vRows = safeVersionId
      ? await sql<Record<string, unknown>>`
          select * from finding_versions where id = ${safeVersionId} limit 1
        `
      : await sql<Record<string, unknown>>`
          select * from finding_versions where finding_id = ${safeFindingId!}
          order by version_no desc limit 1
        `;
  } catch {
    throw new Error("Unauthorized: Database query failed while loading finding version; failing closed.");
  }

  if (vRows.length === 0) {
    throw new Error("Historical finding version not found or access denied.");
  }
  const v = vRows[0];
  const findingId = String(v.finding_id);
  const versionId = String(v.id);

  // Reject manipulated mismatched findingId + findingVersionId pairs
  if (safeFindingId && safeFindingId !== findingId) {
    throw new Error("Unauthorized: Manipulated or mismatched findingId and findingVersionId.");
  }

  let fRows: Array<Record<string, unknown>>;
  try {
    fRows = await sql<Record<string, unknown>>`
      select * from findings where id = ${findingId} limit 1
    `;
  } catch {
    throw new Error("Unauthorized: Database query failed while loading parent finding; failing closed.");
  }
  if (fRows.length === 0) {
    throw new Error("Parent finding not found or access denied.");
  }
  const f = fRows[0];
  const patientId = String(f.patient_id);

  // Enforce fail-closed patient ownership / clinician consent check BEFORE loading any child artifacts
  await checkPatientAndClinicianAccess(sql, uid, patientId, false);

  const studyId = String(v.study_id);
  const studyRows = await sql<Record<string, unknown>>`
    select * from studies where id = ${studyId} and patient_id = ${patientId} limit 1
  `;
  const st = studyRows[0] ?? null;

  const evRows = await sql<Record<string, unknown>>`
    select * from evidence_links where finding_version_id = ${versionId}
  `;

  const resolvedSeriesId =
    (v.series_id as string | null) ??
    (evRows.find((e) => e.series_id != null)?.series_id as string | null) ??
    null;

  let sr: Record<string, unknown> | null = null;
  if (resolvedSeriesId) {
    const srRows = await sql<Record<string, unknown>>`
      select * from series where id = ${resolvedSeriesId} limit 1
    `;
    sr = srRows[0] ?? null;
  } else if (studyId) {
    const srRows = await sql<Record<string, unknown>>`
      select * from series where study_id = ${studyId} order by series_number asc limit 1
    `;
    sr = srRows[0] ?? null;
  }
  const effectiveSeriesId = sr ? String(sr.id) : resolvedSeriesId;

  const segRunId = (v.segmentation_run_id as string | null) ?? null;
  let segRun: Record<string, unknown> | null = null;
  if (segRunId) {
    const runRows = await sql<Record<string, unknown>>`
      select * from segmentation_runs where id = ${segRunId} limit 1
    `;
    segRun = runRows[0] ?? null;
  } else if (effectiveSeriesId) {
    const runRows = await sql<Record<string, unknown>>`
      select * from segmentation_runs where series_id = ${effectiveSeriesId}
      order by created_at desc limit 1
    `;
    segRun = runRows[0] ?? null;
  }

  // Gather all imaging_objects associated with this patient and matching series / study / finding_version / segmentation_run
  const allPatientObjects = await listImagingArtifacts(sql, uid, patientId);
  const linkedObjIds = new Set<string>();
  for (const e of evRows) {
    if (typeof e.imaging_object_id === "string") linkedObjIds.add(e.imaging_object_id);
    if (typeof e.mask_object_id === "string") linkedObjIds.add(e.mask_object_id);
  }
  if (segRun && typeof segRun.mask_object_id === "string") {
    linkedObjIds.add(segRun.mask_object_id);
  }

  const relevantObjects = allPatientObjects.filter((obj) => {
    if (linkedObjIds.has(obj.id)) return true;
    if (obj.findingVersionId && obj.findingVersionId === versionId) return true;
    if (effectiveSeriesId && obj.seriesId === effectiveSeriesId) return true;
    if (studyId && obj.studyId === studyId) return true;
    return false;
  });

  async function hydrateObjects(items: StoredArtifactRecord[]) {
    const out: Array<{ record: StoredArtifactRecord; integrity: ObjectIntegrityReport; data?: Buffer }> = [];
    for (const item of items) {
      const integrity = await verifyImagingObjectIntegrity(sql, uid, item.id);
      let data: Buffer | undefined;
      if (options.includeBinaryPayloads && integrity.integrityOk) {
        const loaded = await getImagingArtifact(sql, uid, item.id);
        data = loaded.data;
      }
      out.push({ ...item, record: item, integrity, ...(data ? { data } : {}) } as any);
    }
    return out;
  }

  const sourceDicomObjects = await hydrateObjects(
    relevantObjects.filter((o) => o.kind === "dicom" || o.kind === "volume"),
  );
  const maskObjects = await hydrateObjects(relevantObjects.filter((o) => o.kind === "mask"));
  const meshObjects = await hydrateObjects(relevantObjects.filter((o) => o.kind === "mesh"));

  const reviewRows = await sql<Record<string, unknown>>`
    select id, user_id, status, note, created_at
    from reviews
    where target_type = 'finding_version' and target_id = ${versionId}
    order by created_at desc
  `;

  const parseTriple = (raw: unknown): [number, number, number] | null => {
    if (!raw) return null;
    try {
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (
        Array.isArray(arr) &&
        arr.length === 3 &&
        arr.every((x) => typeof x === "number" && Number.isFinite(x))
      ) {
        return [arr[0], arr[1], arr[2]];
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  const allHydrated = [...sourceDicomObjects, ...maskObjects, ...meshObjects];
  const corruptedCount = allHydrated.filter((o) => o.integrity.status === "corrupted").length;
  const missingCount = allHydrated.filter((o) => o.integrity.status === "missing").length;
  const allObjectsValid = allHydrated.every((o) => o.integrity.valid);

  return {
    patientId,
    findingId,
    findingCode: String(f.code ?? ""),
    structure: String(f.structure ?? ""),
    organ: String(f.organ ?? ""),
    finding: {
      id: findingId,
      code: String(f.code ?? ""),
      structure: String(f.structure ?? ""),
      organ: String(f.organ ?? ""),
      patient_id: patientId,
    },
    findingVersion: {
      id: versionId,
      versionNo: Number(v.version_no ?? 1),
      previousVersionId: (v.previous_version_id as string | null) ?? null,
      studyId,
      seriesId: effectiveSeriesId,
      observedOn: String(v.observed_on ?? ""),
      locationLabel: String(v.location_label ?? ""),
      figo: (v.figo as string | null) ?? null,
      centroidMm: parseTriple(v.centroid_mm),
      axesMm: parseTriple(v.axes_mm),
      longestMm: v.longest_mm != null ? Number(v.longest_mm) : null,
      volumeMm3: v.volume_mm3 != null ? Number(v.volume_mm3) : null,
      uncertaintyMm3: v.uncertainty_mm3 != null ? Number(v.uncertainty_mm3) : null,
      frame: String(v.frame ?? "unavailable"),
      segmentationSource: String(v.segmentation_source ?? ""),
      modelId: (v.model_id as string | null) ?? null,
      segmentationRunId: segRun ? String(segRun.id) : segRunId,
      quality: String(v.quality ?? "adequate"),
      modality: String(v.modality ?? "MR"),
      changeReason: String(v.change_reason ?? ""),
      createdAt: String(v.created_at ?? ""),
    },
    study: st
      ? {
          id: String(st.id),
          modality: String(st.modality ?? "MR"),
          studyDate: String(st.study_date ?? ""),
          description: String(st.description ?? ""),
          accession: String(st.accession ?? ""),
          studyInstanceUid: (st.study_instance_uid as string | null) ?? null,
        }
      : null,
    series: sr
      ? {
          id: String(sr.id),
          seriesNumber: Number(sr.series_number ?? 1),
          description: String(sr.description ?? ""),
          plane: (sr.plane as string | null) ?? null,
          sliceThicknessMm: sr.slice_thickness_mm != null ? Number(sr.slice_thickness_mm) : null,
          pixelSpacingMm: (sr.pixel_spacing_mm as string | null) ?? null,
          sliceCount: sr.slice_count != null ? Number(sr.slice_count) : null,
          seriesInstanceUid: (sr.series_instance_uid as string | null) ?? null,
          frameOfReferenceUid: (sr.frame_of_reference_uid as string | null) ?? null,
          geometryJson: (sr.geometry_json as string | null) ?? null,
          volumeSha256: (sr.volume_sha256 as string | null) ?? null,
        }
      : null,
    segmentationRun: segRun
      ? {
          id: String(segRun.id),
          modelId: String(segRun.model_id ?? segRun.model_name ?? ""),
          model_name: String(segRun.model_id ?? segRun.model_name ?? ""),
          weightsSha256: (segRun.weights_sha256 as string | null) ?? null,
          paramsJson: String(segRun.params_json ?? "{}"),
          maskObjectId: (segRun.mask_object_id as string | null) ?? null,
          labelCounts: String(segRun.label_counts ?? "{}"),
          volumeMm3: segRun.volume_mm3 != null ? Number(segRun.volume_mm3) : null,
          status: String(segRun.status ?? "completed"),
          createdAt: String(segRun.created_at ?? ""),
        }
      : null,
    integritySummary: {
      totalObjects: allHydrated.length,
      allObjectsValid,
      corruptedCount,
      missingCount,
    },
    sourceDicomObjects,
    maskObjects,
    meshObjects,
    evidenceLinks: evRows.map((e) => ({
      id: String(e.id),
      kind: String(e.kind ?? ""),
      studyId: (e.study_id as string | null) ?? null,
      seriesId: (e.series_id as string | null) ?? null,
      imagingObjectId: (e.imaging_object_id as string | null) ?? null,
      maskObjectId: (e.mask_object_id as string | null) ?? null,
      sliceIndex: e.slice_index != null ? Number(e.slice_index) : null,
      note: String(e.note ?? ""),
    })),
    clinicianReviews: reviewRows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id ?? ""),
      status: String(r.status ?? ""),
      note: String(r.note ?? ""),
      createdAt: String(r.created_at ?? ""),
    })),
  };
}

import { deidentifyDicomBytes, type DeidentificationOptions, type DeidentificationResult } from "../dicom/deidentify.ts";

export interface ExportDeidentifiedDicomOptions extends DeidentificationOptions {
  /** Must be explicitly true to export when potential burned-in pixel annotations require manual review. */
  clinicianReviewedBurnedInPixels?: boolean;
  /** Optional clinician note documenting visual verification of image pixels. */
  clinicianReviewNote?: string;
}

/**
 * Exports a DICOM PS3.15 de-identified derived copy of a stored DICOM artifact while keeping
 * the protected original file on disk unchanged (Sprint 6 Task 2E & 2F).
 *
 * Enforces:
 * 1. Fail-closed authorization (`checkPatientAndClinicianAccess`).
 * 2. Original file immutability (`originalPreserved === true`).
 * 3. Burned-in pixel annotation gate: if `burnedInReport.manualReviewRequired` is true and
 *    `clinicianReviewedBurnedInPixels` is not true, throws an explicit manual-review required error
 *    rather than claiming complete anonymisation.
 * 4. Audit trail (`deidentify_dicom_object`) without exposing patient identifiers or filesystem paths.
 */
export async function exportDeidentifiedDicomArtifact(
  sql: Sql,
  userId: string,
  objectId: string,
  options?: ExportDeidentifiedDicomOptions,
): Promise<
  Omit<DeidentificationResult, "derivedBytes"> & {
    sourceObjectId: string;
    derivedBase64: string;
    clinicianReviewedBurnedInPixels: boolean;
  }
> {
  const loaded = await getImagingArtifact(sql, userId, objectId, true);
  if (!loaded.data) {
    throw new Error("De-identification failed: binary payload is unavailable.");
  }

  const deid = deidentifyDicomBytes(loaded.data, {
    uidSalt: options?.uidSalt,
    dateShiftDays: options?.dateShiftDays,
    patientIdReplacement: options?.patientIdReplacement,
  });

  if (!deid.originalPreserved) {
    throw new Error("Security violation: original DICOM buffer was modified during de-identification.");
  }

  const reviewed = Boolean(options?.clinicianReviewedBurnedInPixels);
  if (deid.manualReviewRequired && !reviewed) {
    await writeAuditEvent(
      sql,
      userId,
      "deidentify_dicom_blocked_manual_review",
      "imaging_object",
      loaded.record.id,
      `Blocked unreviewed de-identified export for object ${loaded.record.id}: potential burned-in pixel annotations (${deid.burnedInReport.riskLevel}) require manual clinician review.`,
    );
    throw new Error(
      `Manual pixel review required before export: metadata tags were de-identified, but potential burned-in pixel identifiers were detected (${deid.burnedInReport.reasons.join(" ") || "BurnedInAnnotation not verified as NO"}). Pass clinicianReviewedBurnedInPixels: true after visual inspection.`,
    );
  }

  await writeAuditEvent(
    sql,
    userId,
    "deidentify_dicom_object",
    "imaging_object",
    loaded.record.id,
    `Exported PS3.15 de-identified derived copy for object ${loaded.record.id} (derived sha256 ${deid.derivedSha256.slice(0, 12)}…, standard tags scrubbed: ${deid.standardTagsScrubbed.length}, private tags removed: ${deid.privateTagsRemoved.length}, nested tags scrubbed: ${deid.nestedSequenceTagsScrubbed.length}, burned-in risk: ${deid.burnedInReport.riskLevel}, manual review confirmed: ${reviewed}).`,
  );

  const { derivedBytes, ...rest } = deid;
  return {
    ...rest,
    sourceObjectId: loaded.record.id,
    derivedBase64: Buffer.from(derivedBytes).toString("base64"),
    clinicianReviewedBurnedInPixels: reviewed,
  };
}

/**
 * Workstream 4 — Production Storage Adapter Configuration, Backup, Actual Restoration,
 * and Storage Consistency Monitoring.
 */
export interface StorageBackendConfig {
  backend: "local_durable" | "s3_compatible";
  storageBaseDir: string;
  backupBaseDir: string;
  s3Endpoint?: string | null;
  s3Bucket?: string | null;
  s3Region?: string | null;
  credentialsServerSideOnly: true;
  publicUrlsDisabled: true;
}

export function validateStorageBackendConfig(
  env: Record<string, string | undefined> = process.env,
): StorageBackendConfig {
  const rawBackend = (env.REPROCARE_STORAGE_BACKEND || "local_durable").trim().toLowerCase();
  const backend = rawBackend === "s3_compatible" ? "s3_compatible" : "local_durable";
  const storageBaseDir = resolve(
    env.REPROCARE_IMAGING_STORAGE_DIR || env.IMAGING_STORAGE_PATH || DEFAULT_STORAGE_PATH,
  );
  const backupBaseDir = resolve(
    env.REPROCARE_IMAGING_BACKUP_DIR || join(storageBaseDir, "..", "imaging-backups"),
  );

  // Reject any configuration that attempts to expose public medical-image bucket URLs to the browser
  if (
    env.VITE_S3_SECRET_ACCESS_KEY ||
    env.VITE_IMAGING_PUBLIC_BUCKET_URL ||
    env.REPROCARE_ALLOW_PUBLIC_IMAGING_URLS === "true"
  ) {
    throw new Error(
      "Security violation: storage credentials and medical-image URLs must remain strictly server-side and never be exposed publicly.",
    );
  }

  if (backend === "s3_compatible") {
    if (!env.REPROCARE_S3_BUCKET || !env.REPROCARE_S3_ACCESS_KEY_ID || !env.REPROCARE_S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "Invalid S3-compatible storage configuration: REPROCARE_S3_BUCKET, REPROCARE_S3_ACCESS_KEY_ID, and REPROCARE_S3_SECRET_ACCESS_KEY are required on the server.",
      );
    }
  }

  return {
    backend,
    storageBaseDir,
    backupBaseDir,
    s3Endpoint: env.REPROCARE_S3_ENDPOINT || null,
    s3Bucket: env.REPROCARE_S3_BUCKET || null,
    s3Region: env.REPROCARE_S3_REGION || "ap-south-1",
    credentialsServerSideOnly: true,
    publicUrlsDisabled: true,
  };
}

export interface ImagingBackupManifest {
  backupId: string;
  createdAt: string;
  createdBy: string;
  patientIdFilter: string | null;
  objectCount: number;
  totalBytes: number;
  manifestSha256: string;
  objects: Array<{
    id: string;
    patientId: string;
    userId: string;
    studyId: string | null;
    seriesId: string | null;
    findingVersionId: string | null;
    sourceObjectId: string | null;
    kind: string;
    storageUri: string;
    backupBlobRelativePath: string;
    sha256: string;
    bytes: number;
    version: number;
    mimeType: string | null;
    originalFilename: string | null;
    metadataJson: string;
    status: string;
    retentionUntil: string | null;
  }>;
  auditOutboxCount: number;
}

/**
 * Creates a verified, checksum-manifested backup of active medical imaging artifacts
 * (`manifest.json` + `blobs/*` + `audit-outbox.jsonl`).
 */
export async function createImagingStorageBackup(
  sql: Sql,
  userId: string,
  options?: {
    patientId?: string;
    backupDir?: string;
  },
): Promise<{ backupDir: string; manifestPath: string; manifest: ImagingBackupManifest }> {
  const { uid, role } = await verifyCallerIdentityAndProfile(sql, userId);
  const patientIdFilter = options?.patientId ? validateSafeId(options.patientId, "patientId") : null;

  if (patientIdFilter) {
    await checkPatientAndClinicianAccess(sql, uid, patientIdFilter, false);
  } else if (role !== "admin") {
    throw new Error("Unauthorized: Full-system imaging backup requires administrator privileges or a specific authorized patientId.");
  }

  const base = resolve(getStorageBase());
  const defaultBackupRoot =
    process.env.REPROCARE_IMAGING_BACKUP_DIR || join(base, "..", "reprocare-backups");
  const backupId = `bkp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const targetBackupDir = resolve(options?.backupDir || join(defaultBackupRoot, backupId));
  const blobsDir = join(targetBackupDir, "blobs");
  await mkdir(blobsDir, { recursive: true });

  const rows = patientIdFilter
    ? await sql<Record<string, unknown>>`
        select * from imaging_objects
        where patient_id = ${patientIdFilter} and coalesce(status, 'active') = 'active'
        order by created_at asc
      `
    : await sql<Record<string, unknown>>`
        select * from imaging_objects
        where coalesce(status, 'active') = 'active'
        order by created_at asc
      `;

  const manifestObjects: ImagingBackupManifest["objects"] = [];
  let totalBytes = 0;

  for (const row of rows) {
    const rec = mapArtifactRow(row);
    const srcPath = resolve(base, rec.storageUri);
    if (!srcPath.startsWith(base)) {
      throw new Error(`Security violation: invalid storageUri during backup for object ${rec.id}.`);
    }
    const data = await readFile(srcPath);
    const actualSha = createHash("sha256").update(data).digest("hex");
    if (actualSha !== rec.sha256) {
      throw new Error(
        `Backup aborted: active imaging object ${rec.id} failed SHA-256 verification before backup.`,
      );
    }

    const blobRel = `${rec.id}_${rec.sha256.slice(0, 16)}.bin`;
    const dstPath = join(blobsDir, blobRel);
    await writeFile(dstPath, data);

    // Verify written backup blob checksum
    const verifyData = await readFile(dstPath);
    const verifySha = createHash("sha256").update(verifyData).digest("hex");
    if (verifySha !== rec.sha256) {
      throw new Error(`Backup verification failed for object ${rec.id}.`);
    }

    totalBytes += data.byteLength;
    manifestObjects.push({
      id: rec.id,
      patientId: rec.patientId,
      userId: rec.userId,
      studyId: rec.studyId,
      seriesId: rec.seriesId,
      findingVersionId: rec.findingVersionId,
      sourceObjectId: rec.sourceObjectId,
      kind: rec.kind,
      storageUri: rec.storageUri,
      backupBlobRelativePath: `blobs/${blobRel}`,
      sha256: rec.sha256,
      bytes: rec.bytes,
      version: rec.version,
      mimeType: rec.mimeType,
      originalFilename: rec.originalFilename,
      metadataJson: JSON.stringify(rec.metadata ?? {}),
      status: "active",
      retentionUntil: rec.retentionUntil,
    });
  }

  const outboxEntries = await readDurableAuditOutbox();
  if (outboxEntries.length > 0) {
    await writeFile(
      join(targetBackupDir, "audit-outbox-backup.jsonl"),
      outboxEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }

  const createdAt = new Date().toISOString();
  const manifestCore = {
    backupId,
    createdAt,
    createdBy: uid,
    patientIdFilter,
    objectCount: manifestObjects.length,
    totalBytes,
    objects: manifestObjects,
    auditOutboxCount: outboxEntries.length,
  };
  const manifestSha256 = createHash("sha256").update(JSON.stringify(manifestCore)).digest("hex");
  const manifest: ImagingBackupManifest = {
    ...manifestCore,
    manifestSha256,
  };

  const manifestPath = join(targetBackupDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  await writeAuditEvent(
    sql,
    uid,
    "create_imaging_backup",
    "imaging_backup",
    backupId,
    `Created verified imaging storage backup ${backupId} (${manifest.objectCount} objects, ${manifest.totalBytes} bytes, sha256 ${manifestSha256.slice(0, 12)}…).`,
  );

  return { backupDir: targetBackupDir, manifestPath, manifest };
}

/**
 * Restores medical imaging binary artifacts and database metadata from a verified backup bundle,
 * validating every restored binary file's SHA-256 checksum after restoration.
 */
export async function restoreImagingStorageBackup(
  sql: Sql,
  userId: string,
  backupDir: string,
): Promise<{
  backupId: string;
  restoredCount: number;
  verifiedCount: number;
  restoredObjectIds: string[];
}> {
  const { uid, role } = await verifyCallerIdentityAndProfile(sql, userId);
  const resolvedBackupDir = resolve(backupDir);
  const manifestPath = join(resolvedBackupDir, "manifest.json");

  const rawManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifest) as ImagingBackupManifest;

  const { manifestSha256, ...manifestCore } = manifest;
  const expectedManifestSha = createHash("sha256").update(JSON.stringify(manifestCore)).digest("hex");
  if (expectedManifestSha !== manifestSha256) {
    throw new Error("Backup restoration aborted: backup manifest.json checksum verification failed.");
  }

  if (manifest.patientIdFilter) {
    await checkPatientAndClinicianAccess(sql, uid, manifest.patientIdFilter, true);
  } else if (role !== "admin") {
    throw new Error("Unauthorized: Full-system backup restoration requires administrator privileges.");
  }

  const base = resolve(getStorageBase());
  const restoredObjectIds: string[] = [];
  let verifiedCount = 0;

  for (const obj of manifest.objects) {
    if (!manifest.patientIdFilter && role !== "admin") {
      await checkPatientAndClinicianAccess(sql, uid, obj.patientId, true);
    }
    const backupBlobPath = resolve(resolvedBackupDir, obj.backupBlobRelativePath);
    if (!backupBlobPath.startsWith(resolvedBackupDir)) {
      throw new Error(`Security violation: invalid backup blob path for object ${obj.id}.`);
    }

    const blobBytes = await readFile(backupBlobPath);
    const blobSha = createHash("sha256").update(blobBytes).digest("hex");
    if (blobSha !== obj.sha256) {
      throw new Error(
        `Backup restoration aborted: backup blob for object ${obj.id} is corrupted (expected ${obj.sha256}, got ${blobSha}).`,
      );
    }

    const dstPath = resolve(base, obj.storageUri);
    if (!dstPath.startsWith(base)) {
      throw new Error(`Security violation: invalid destination storageUri for object ${obj.id}.`);
    }

    await mkdir(dirname(dstPath), { recursive: true });
    await writeFile(dstPath, blobBytes);

    // Verify restored file on disk
    const restoredDiskBytes = await readFile(dstPath);
    const restoredDiskSha = createHash("sha256").update(restoredDiskBytes).digest("hex");
    if (restoredDiskSha !== obj.sha256 || restoredDiskBytes.byteLength !== obj.bytes) {
      throw new Error(`Restoration post-write verification failed for object ${obj.id}.`);
    }
    verifiedCount += 1;

    // Ensure database row exists and is marked 'active'
    const existingRows = await sql<{ id: string }>`
      select id from imaging_objects where id = ${obj.id}
    `;
    if (existingRows.length > 0) {
      try {
        await sql`
          update imaging_objects
          set status = 'active', sha256 = ${obj.sha256}, bytes = ${obj.bytes}, updated_at = now()
          where id = ${obj.id}
        `;
      } catch {
        await sql`
          update imaging_objects
          set status = 'active', sha256 = ${obj.sha256}, bytes = ${obj.bytes}
          where id = ${obj.id}
        `;
      }
    } else {
      const dbCompatKind =
        obj.kind === "dicom" || obj.kind === "mask" || obj.kind === "mesh" || obj.kind === "volume"
          ? obj.kind
          : "volume";
      try {
        await sql`
          insert into imaging_objects (
            id, user_id, patient_id, study_id, series_id, finding_version_id, source_object_id,
            kind, storage_uri, sha256, bytes, version, mime_type, original_filename,
            metadata_json, status, created_by, retention_until
          ) values (
            ${obj.id}, ${obj.userId}, ${obj.patientId}, ${obj.studyId}, ${obj.seriesId},
            ${obj.findingVersionId}, ${obj.sourceObjectId}, ${dbCompatKind}, ${obj.storageUri},
            ${obj.sha256}, ${obj.bytes}, ${obj.version}, ${obj.mimeType}, ${obj.originalFilename},
            ${obj.metadataJson}, 'active', ${uid}, ${obj.retentionUntil}
          )
        `;
      } catch {
        await sql`
          insert into imaging_objects (
            id, user_id, patient_id, series_id, kind, storage_uri, sha256, bytes, version, created_by, retention_until
          ) values (
            ${obj.id}, ${obj.userId}, ${obj.patientId}, ${obj.seriesId},
            ${dbCompatKind}, ${obj.storageUri}, ${obj.sha256}, ${obj.bytes}, ${obj.version},
            ${uid}, ${obj.retentionUntil}
          )
        `;
      }
    }

    restoredObjectIds.push(obj.id);
  }

  await flushPendingAuditOutbox(sql);
  await writeAuditEvent(
    sql,
    uid,
    "restore_imaging_backup",
    "imaging_backup",
    manifest.backupId,
    `Restored and verified ${restoredObjectIds.length} imaging object(s) from backup ${manifest.backupId}.`,
  );

  return {
    backupId: manifest.backupId,
    restoredCount: restoredObjectIds.length,
    verifiedCount,
    restoredObjectIds,
  };
}

export interface StorageConsistencyReport {
  checkedAt: string;
  totalDbObjects: number;
  healthyActiveCount: number;
  purgedConsistentCount: number;
  missingBlobObjectIds: string[];
  corruptedBlobObjectIds: string[];
  purgedWithLingeringFileObjectIds: string[];
  repairedCount: number;
  consistent: boolean;
}

/**
 * Scans database `imaging_objects` rows against physical storage to detect and optionally
 * reconcile missing blobs, checksum corruption, or lingering files on purged records.
 */
export async function reconcileImagingStorageConsistency(
  sql: Sql,
  userId: string,
  options?: {
    patientId?: string;
    repairStatuses?: boolean;
  },
): Promise<StorageConsistencyReport> {
  const { uid, role } = await verifyCallerIdentityAndProfile(sql, userId);
  const patientIdFilter = options?.patientId ? validateSafeId(options.patientId, "patientId") : null;
  if (patientIdFilter) {
    await checkPatientAndClinicianAccess(sql, uid, patientIdFilter, Boolean(options?.repairStatuses));
  } else if (role !== "admin") {
    throw new Error("Unauthorized: System-wide storage consistency reconciliation requires administrator privileges or a specific patientId.");
  }

  const rows = patientIdFilter
    ? await sql<Record<string, unknown>>`
        select * from imaging_objects where patient_id = ${patientIdFilter} order by created_at asc
      `
    : await sql<Record<string, unknown>>`
        select * from imaging_objects order by created_at asc
      `;

  const base = resolve(getStorageBase());
  let healthyActiveCount = 0;
  let purgedConsistentCount = 0;
  let repairedCount = 0;
  const missingBlobObjectIds: string[] = [];
  const corruptedBlobObjectIds: string[] = [];
  const purgedWithLingeringFileObjectIds: string[] = [];

  for (const row of rows) {
    const rec = mapArtifactRow(row);
    const fullPath = resolve(base, rec.storageUri);
    let fileExists = false;
    let fileBytes: Buffer | null = null;
    if (fullPath.startsWith(base)) {
      try {
        fileBytes = await readFile(fullPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
    }

    if (rec.status === "purged") {
      if (fileExists) {
        purgedWithLingeringFileObjectIds.push(rec.id);
        if (options?.repairStatuses && fullPath.startsWith(base)) {
          await unlink(fullPath).catch(() => undefined);
          repairedCount += 1;
        }
      } else {
        purgedConsistentCount += 1;
      }
      continue;
    }

    if (!fileExists || !fileBytes) {
      missingBlobObjectIds.push(rec.id);
      if (options?.repairStatuses) {
        await sql`
          update imaging_objects set status = 'missing' where id = ${rec.id}
        `.catch(() => undefined);
        repairedCount += 1;
      }
      continue;
    }

    const actualSha = createHash("sha256").update(fileBytes).digest("hex");
    if (actualSha !== rec.sha256 || fileBytes.byteLength !== rec.bytes) {
      corruptedBlobObjectIds.push(rec.id);
      if (options?.repairStatuses) {
        await sql`
          update imaging_objects set status = 'corrupted' where id = ${rec.id}
        `.catch(() => undefined);
        repairedCount += 1;
      }
      continue;
    }

    healthyActiveCount += 1;
  }

  const consistent =
    missingBlobObjectIds.length === 0 &&
    corruptedBlobObjectIds.length === 0 &&
    purgedWithLingeringFileObjectIds.length === 0;

  await writeAuditEvent(
    sql,
    uid,
    "reconcile_imaging_storage",
    "imaging_storage",
    patientIdFilter ?? "system",
    `Storage consistency check complete: ${healthyActiveCount} healthy active, ${purgedConsistentCount} purged, ${missingBlobObjectIds.length} missing, ${corruptedBlobObjectIds.length} corrupted, ${purgedWithLingeringFileObjectIds.length} lingering purged files (repaired: ${repairedCount}).`,
  );

  return {
    checkedAt: new Date().toISOString(),
    totalDbObjects: rows.length,
    healthyActiveCount,
    purgedConsistentCount,
    missingBlobObjectIds,
    corruptedBlobObjectIds,
    purgedWithLingeringFileObjectIds,
    repairedCount,
    consistent,
  };
}
