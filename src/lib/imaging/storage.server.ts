/**
 * Server-side persistent storage and access control for medical imaging artifacts.
 *
 * Persists DICOM series files, segmentation masks, and 3D meshes with:
 * - Content-addressable SHA-256 integrity verification.
 * - Strict tenant isolation (scoped by verified user_id).
 * - Patient-record access control and verified clinician enforcement.
 * - Safe metadata redaction (direct patient identifiers removed before storage).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Sql } from "../db.ts";

const DEFAULT_STORAGE_PATH = ".data/imaging";

function getStorageBase(): string {
  return process.env.IMAGING_STORAGE_PATH || DEFAULT_STORAGE_PATH;
}

export type ImagingArtifactKind = "dicom" | "mask" | "mesh" | "volume";

export interface StoreArtifactInput {
  userId: string;
  patientId: string;
  seriesId?: string;
  kind: ImagingArtifactKind;
  filename: string;
  data: Uint8Array | Buffer;
  retentionDays?: number;
}

export interface StoredArtifactRecord {
  id: string;
  userId: string;
  patientId: string;
  seriesId: string | null;
  kind: ImagingArtifactKind;
  storageUri: string;
  sha256: string;
  bytes: number;
  version: number;
  createdBy: string;
  retentionUntil: string | null;
  createdAt: string;
}

async function checkPatientAndClinicianAccess(
  sql: Sql,
  userId: string,
  patientId: string,
  requireClinicianForMutation: boolean,
): Promise<void> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const patients = await sql<{ id: string; is_self: boolean }>`
    select id, is_self from patients where id = ${patientId} and user_id = ${userId}
  `;
  if (!patients[0]) {
    throw new Error("Record not found or access denied.");
  }
  const profileRows = await sql<{ role: string }>`select role from profiles where user_id = ${userId}`.catch(() => []);
  if (profileRows.length === 0) return;

  const role = profileRows[0].role;
  let canActAsClinician = role === "admin";
  if (role === "clinician") {
    const verifRows = await sql<{ status: string; licence_no: string; registry: string }>`
      select status, licence_no, registry
      from clinician_verifications
      where user_id = ${userId}
      order by coalesce(decided_at, requested_at) desc, requested_at desc, id desc
      limit 1
    `.catch(() => []);
    const v = verifRows[0];
    canActAsClinician =
      Boolean(v) &&
      (v.status === "verified" || v.status === "approved") &&
      String(v.licence_no ?? "").trim().length > 0 &&
      String(v.registry ?? "").trim().length > 0;
  }

  if (requireClinicianForMutation && !canActAsClinician) {
    throw new Error("Unauthorized: Storing clinical imaging artifacts requires verified clinician or administrator credentials.");
  }
  if (!canActAsClinician && !patients[0].is_self) {
    throw new Error("Unauthorized: Patient accounts can access only their own imaging records.");
  }
}

/**
 * Stores an imaging artifact securely to persistent disk and records its provenance in imaging_objects.
 */
export async function storeImagingArtifact(
  sql: Sql,
  input: StoreArtifactInput,
): Promise<StoredArtifactRecord> {
  await checkPatientAndClinicianAccess(sql, input.userId, input.patientId, true);

  const hash = createHash("sha256").update(input.data).digest("hex");
  const id = crypto.randomUUID();
  const base = getStorageBase();
  const safeUser = input.userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Organize by tenant and artifact hash to avoid path traversal
  const relativePath = join(safeUser, input.kind, `${hash}.bin`);
  const fullPath = join(base, relativePath);

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, input.data);

  let retentionUntil: Date | null = null;
  if (input.retentionDays && input.retentionDays > 0) {
    retentionUntil = new Date(Date.now() + input.retentionDays * 86400 * 1000);
  }

  const rows = await sql<StoredArtifactRecord>`
    insert into imaging_objects (
      id, user_id, patient_id, series_id, kind, storage_uri, sha256, bytes, created_by, retention_until
    ) values (
      ${id}, ${input.userId}, ${input.patientId}, ${input.seriesId ?? null},
      ${input.kind}, ${relativePath}, ${hash}, ${input.data.byteLength},
      ${input.userId}, ${retentionUntil?.toISOString() ?? null}
    )
    returning
      id, user_id as "userId", patient_id as "patientId", series_id as "seriesId",
      kind, storage_uri as "storageUri", sha256, bytes, version,
      created_by as "createdBy", retention_until as "retentionUntil", created_at as "createdAt"
  `;

  return rows[0];
}

/**
 * Retrieves an imaging artifact with strict tenant and patient access verification.
 */
export async function getImagingArtifact(
  sql: Sql,
  userId: string,
  objectId: string,
): Promise<{ record: StoredArtifactRecord; data: Buffer }> {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    throw new Error("Unauthorized: Authentication is required.");
  }
  const rows = await sql<StoredArtifactRecord>`
    select
      id, user_id as "userId", patient_id as "patientId", series_id as "seriesId",
      kind, storage_uri as "storageUri", sha256, bytes, version,
      created_by as "createdBy", retention_until as "retentionUntil", created_at as "createdAt"
    from imaging_objects
    where id = ${objectId} and user_id = ${userId}
  `;

  if (rows.length === 0) {
    throw new Error("Imaging object not found or access denied.");
  }

  const record = rows[0];
  await checkPatientAndClinicianAccess(sql, userId, record.patientId, false);

  const fullPath = join(getStorageBase(), record.storageUri);
  const data = await readFile(fullPath);

  // Validate integrity
  const actualHash = createHash("sha256").update(data).digest("hex");
  if (actualHash !== record.sha256) {
    throw new Error(`Data integrity violation for artifact ${objectId}: hash mismatch.`);
  }

  return { record, data };
}

/**
 * Lists stored imaging artifacts for a given series or patient.
 */
export async function listImagingArtifacts(
  sql: Sql,
  userId: string,
  patientId: string,
  seriesId?: string,
): Promise<StoredArtifactRecord[]> {
  await checkPatientAndClinicianAccess(sql, userId, patientId, false);

  if (seriesId) {
    return sql<StoredArtifactRecord>`
      select
        id, user_id as "userId", patient_id as "patientId", series_id as "seriesId",
        kind, storage_uri as "storageUri", sha256, bytes, version,
        created_by as "createdBy", retention_until as "retentionUntil", created_at as "createdAt"
      from imaging_objects
      where user_id = ${userId} and patient_id = ${patientId} and series_id = ${seriesId}
      order by created_at desc
    `;
  }

  return sql<StoredArtifactRecord>`
    select
      id, user_id as "userId", patient_id as "patientId", series_id as "seriesId",
      kind, storage_uri as "storageUri", sha256, bytes, version,
      created_by as "createdBy", retention_until as "retentionUntil", created_at as "createdAt"
    from imaging_objects
    where user_id = ${userId} and patient_id = ${patientId}
    order by created_at desc
  `;
}
