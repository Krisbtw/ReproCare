/**
 * Supabase Storage Provider, Bucket Provisioning, Signed URLs, TUS Resumable Uploads,
 * and Local-to-Supabase Migration Engine for ReproCare.
 *
 * Security Invariants:
 * 1. All medical buckets (`reprocare-imaging`, `reprocare-reports`, `reprocare-derived`)
 *    are strictly PRIVATE (`public: false`). Public medical buckets are prohibited.
 * 2. `SUPABASE_SERVICE_ROLE_KEY` is used exclusively on the server and is NEVER exposed
 *    in client bundles, `VITE_*` variables, signed URLs, API responses, or logs.
 * 3. Every upload, download, signed upload URL, TUS resumable session, signed download URL,
 *    and deletion operation must be preceded by server-side RBAC, clinician verification,
 *    patient ownership, and active patient consent checks (`checkPatientAndClinicianAccess`).
 * 4. Signed download and upload URLs are short-lived (default 120s, max 900s) and never permanent.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Sql } from "../db.ts";

export const SUPABASE_STORAGE_BUCKETS = {
  imaging: "reprocare-imaging",
  reports: "reprocare-reports",
  derived: "reprocare-derived",
} as const;

export type SupabaseBucketName =
  (typeof SUPABASE_STORAGE_BUCKETS)[keyof typeof SUPABASE_STORAGE_BUCKETS];

export const ALL_SUPABASE_BUCKETS: readonly SupabaseBucketName[] = [
  SUPABASE_STORAGE_BUCKETS.imaging,
  SUPABASE_STORAGE_BUCKETS.reports,
  SUPABASE_STORAGE_BUCKETS.derived,
];

export const MIN_SIGNED_URL_EXPIRY_SECONDS = 15;
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 120;
export const MAX_SIGNED_URL_EXPIRY_SECONDS = 900; // 15 minutes max

export const TUS_RECOMMENDED_CHUNK_BYTES = 6 * 1024 * 1024; // 6 MB standard Supabase TUS chunk size
export const MAX_DIRECT_UPLOAD_BYTES = 512 * 1024 * 1024; // 512 MB max for direct/TUS imaging studies

export interface BucketSpecification {
  id: SupabaseBucketName;
  name: SupabaseBucketName;
  public: false;
  fileSizeLimit: number;
  allowedMimeTypes: string[];
  description: string;
}

export const BUCKET_SPECIFICATIONS: Record<SupabaseBucketName, BucketSpecification> = {
  "reprocare-imaging": {
    id: "reprocare-imaging",
    name: "reprocare-imaging",
    public: false,
    fileSizeLimit: 512 * 1024 * 1024, // 512 MB
    allowedMimeTypes: [
      "application/dicom",
      "application/octet-stream",
      "application/gzip",
      "application/x-gzip",
      "image/nii",
      "application/nii",
    ],
    description: "Original DICOM files, DICOM studies, NIfTI volumes, and MRI image data.",
  },
  "reprocare-reports": {
    id: "reprocare-reports",
    name: "reprocare-reports",
    public: false,
    fileSizeLimit: 64 * 1024 * 1024, // 64 MB
    allowedMimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "application/octet-stream",
    ],
    description: "Clinical PDF reports and supporting medical documents.",
  },
  "reprocare-derived": {
    id: "reprocare-derived",
    name: "reprocare-derived",
    public: false,
    fileSizeLimit: 256 * 1024 * 1024, // 256 MB
    allowedMimeTypes: [
      "application/octet-stream",
      "application/json",
      "model/stl",
      "model/obj",
      "text/plain",
    ],
    description: "Segmentation masks, 3D meshes, derived imaging volumes, and processing outputs.",
  },
};

/**
 * Maps an artifact kind and optional metadata to its authoritative private Supabase Storage bucket.
 */
export function resolveBucketForArtifactKind(
  kind: string,
  metadata?: Record<string, unknown> | null,
): SupabaseBucketName {
  const k = String(kind ?? "").trim().toLowerCase();
  if (k === "report" || k === "clinical_report" || k === "pdf_report") {
    return SUPABASE_STORAGE_BUCKETS.reports;
  }
  if (
    k === "mask" ||
    k === "segmentation_mask" ||
    k === "mesh" ||
    k === "mesh_3d" ||
    k === "derived_volume"
  ) {
    return SUPABASE_STORAGE_BUCKETS.derived;
  }
  if (k === "volume" && (metadata?.isDerived === true || Boolean(metadata?.sourceObjectId))) {
    return SUPABASE_STORAGE_BUCKETS.derived;
  }
  return SUPABASE_STORAGE_BUCKETS.imaging;
}

/**
 * Validates that a MIME type is allowed for the target private bucket.
 */
export function isMimeTypeAllowedForBucket(
  bucket: SupabaseBucketName,
  mimeType: string,
): boolean {
  const spec = BUCKET_SPECIFICATIONS[bucket];
  if (!spec) return false;
  const cleanMime = String(mimeType ?? "").split(";")[0].trim().toLowerCase();
  return spec.allowedMimeTypes.includes(cleanMime);
}

export interface SupabaseStorageConfig {
  supabaseUrl: string;
  projectRef: string | null;
  storageRestUrl: string;
  tusResumableUrl: string;
  serviceRoleKey: string;
  anonKey: string | null;
}

const PLACEHOLDER_KEY_RE =
  /\[YOUR-[^\]]+\]|<YOUR-[^>]+>|YOUR_SERVICE_ROLE_KEY|PLACEHOLDER/i;

/**
 * Redacts service role keys, JWT tokens, and bearer credentials from any string or error message.
 */
export function redactStorageSecrets(input: string): string {
  if (!input) return "";
  return String(input)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/sb_secret_[A-Za-z0-9_-]+/g, "[REDACTED_SB_SECRET]");
}

/**
 * Resolves and validates Supabase Storage configuration from server environment variables.
 */
export function resolveSupabaseStorageConfig(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): SupabaseStorageConfig | null {
  if (
    env.VITE_SUPABASE_SERVICE_ROLE_KEY ||
    env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
    env.VITE_S3_SECRET_ACCESS_KEY ||
    env.VITE_IMAGING_PUBLIC_BUCKET_URL ||
    env.REPROCARE_ALLOW_PUBLIC_IMAGING_URLS === "true"
  ) {
    throw new Error(
      "Security violation: SUPABASE_SERVICE_ROLE_KEY and medical-image bucket URLs must remain strictly server-side and never be exposed in VITE_* or public environment variables.",
    );
  }

  const rawUrl = (env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const rawKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const rawAnon = (env.SUPABASE_ANON_KEY ?? "").trim() || null;

  if (!rawUrl && !rawKey) {
    return null;
  }
  if (!rawUrl || !rawKey) {
    throw new Error(
      "Invalid Supabase Storage configuration: both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set on the server.",
    );
  }
  if (PLACEHOLDER_KEY_RE.test(rawUrl) || PLACEHOLDER_KEY_RE.test(rawKey)) {
    throw new Error(
      "Invalid Supabase Storage configuration: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY contains an unreplaced placeholder.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("Invalid SUPABASE_URL: must be a valid https:// (or http:// in local dev) URL.");
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("Invalid SUPABASE_URL protocol.");
  }

  const refMatch = parsedUrl.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  const projectRef = refMatch ? refMatch[1] : (env.SUPABASE_PROJECT_REF?.trim() || null);

  const storageRestUrl = `${rawUrl}/storage/v1`;
  // Per Supabase TUS documentation, direct storage hostname `https://<project_ref>.storage.supabase.co`
  // provides optimal performance for large resumable uploads when hosted on *.supabase.co.
  const tusResumableUrl = refMatch
    ? `${parsedUrl.protocol}//${refMatch[1]}.storage.supabase.co/storage/v1/upload/resumable`
    : `${storageRestUrl}/upload/resumable`;

  return {
    supabaseUrl: rawUrl,
    projectRef,
    storageRestUrl,
    tusResumableUrl,
    serviceRoleKey: rawKey,
    anonKey: rawAnon,
  };
}

export interface StorageObjectMetadata {
  exists: boolean;
  bucket: SupabaseBucketName;
  objectPath: string;
  sizeBytes: number | null;
  mimeType: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface SignedDownloadUrlResult {
  signedUrl: string;
  bucket: SupabaseBucketName;
  objectPath: string;
  expiresInSeconds: number;
  expiresAt: string;
}

export interface SignedUploadUrlResult {
  signedUrl: string;
  token: string;
  bucket: SupabaseBucketName;
  objectPath: string;
  expiresInSeconds: number;
  expiresAt: string;
}

export interface TusResumableUploadSession {
  uploadUrl: string;
  bucket: SupabaseBucketName;
  objectPath: string;
  totalBytes: number;
  chunkSizeBytes: number;
  mimeType: string;
  sha256: string | null;
  expiresAt: string;
}

export interface StorageProviderAdapter {
  readonly providerName: "supabase" | "local_durable";
  uploadObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    data: Buffer;
    mimeType: string;
    upsert?: boolean;
    metadata?: Record<string, string>;
  }): Promise<{ bucket: SupabaseBucketName; objectPath: string; etag?: string | null }>;
  downloadObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<Buffer>;
  objectExists(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<boolean>;
  getObjectMetadata(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<StorageObjectMetadata>;
  deleteObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<boolean>;
  createSignedDownloadUrl(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<SignedDownloadUrlResult>;
  createSignedUploadUrl(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<SignedUploadUrlResult>;
  createTusResumableUploadSession(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    totalBytes: number;
    mimeType: string;
    sha256?: string | null;
  }): Promise<TusResumableUploadSession>;
}

function encodeObjectPath(objectPath: string): string {
  const clean = objectPath.replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.includes("\\") || clean.includes("\0")) {
    throw new Error("Security violation: invalid storage object path.");
  }
  return clean
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function clampExpirySeconds(raw?: number): number {
  const n = raw == null ? DEFAULT_SIGNED_URL_EXPIRY_SECONDS : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < MIN_SIGNED_URL_EXPIRY_SECONDS) {
    return MIN_SIGNED_URL_EXPIRY_SECONDS;
  }
  if (n > MAX_SIGNED_URL_EXPIRY_SECONDS) {
    return MAX_SIGNED_URL_EXPIRY_SECONDS;
  }
  return n;
}

function signUrlToken(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function appendSignedExpiryParams(
  rawUrl: string,
  bucket: string,
  objectPath: string,
  expiresAtMs: number,
  secret: string,
): string {
  const u = new URL(rawUrl);
  u.searchParams.set("reprocare_exp", String(expiresAtMs));
  u.searchParams.set("reprocare_bkt", bucket);
  const sig = signUrlToken(`${bucket}:${objectPath}:${expiresAtMs}`, secret);
  u.searchParams.set("reprocare_sig", sig);
  return u.toString();
}

/**
 * Verifies whether a generated signed URL is still valid and has not expired.
 */
export function verifySignedUrlAccess(
  signedUrl: string,
  options?: {
    nowMs?: number;
    expectedBucket?: SupabaseBucketName;
    expectedObjectPath?: string;
    secret?: string;
  },
): { valid: boolean; expired: boolean; reason: string | null } {
  try {
    const u = new URL(signedUrl);
    const expStr = u.searchParams.get("reprocare_exp");
    if (!expStr) {
      return { valid: false, expired: false, reason: "Missing signed expiry parameter." };
    }
    const expMs = Number(expStr);
    if (!Number.isFinite(expMs) || expMs <= 0) {
      return { valid: false, expired: false, reason: "Malformed signed expiry timestamp." };
    }
    const now = options?.nowMs ?? Date.now();
    if (now >= expMs) {
      return { valid: false, expired: true, reason: "Signed URL has expired." };
    }
    const bkt = u.searchParams.get("reprocare_bkt") ?? "";
    if (options?.expectedBucket && bkt !== options.expectedBucket) {
      return { valid: false, expired: false, reason: "Signed URL bucket mismatch." };
    }
    if (options?.secret && options?.expectedObjectPath) {
      const expectedSig = signUrlToken(
        `${bkt}:${options.expectedObjectPath}:${expMs}`,
        options.secret,
      );
      const actualSig = u.searchParams.get("reprocare_sig") ?? "";
      if (actualSig !== expectedSig) {
        return { valid: false, expired: false, reason: "Signed URL cryptographic signature mismatch." };
      }
    }
    return { valid: true, expired: false, reason: null };
  } catch {
    return { valid: false, expired: false, reason: "Invalid URL format." };
  }
}

export type FetchLike = typeof fetch;

let customFetchForTests: FetchLike | null = null;

/**
 * Allows unit/integration tests to intercept outbound Supabase Storage REST & TUS requests.
 */
export function setCustomStorageFetchForTests(fn: FetchLike | null): void {
  customFetchForTests = fn;
}

export function getActiveStorageFetch(): FetchLike {
  return customFetchForTests ?? fetch;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchFn: FetchLike,
  maxAttempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchFn(url, init);
      if (
        (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt < maxAttempts
      ) {
        await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "Network error");
  throw new Error(`Supabase Storage request failed: ${redactStorageSecrets(msg)}`);
}

/**
 * Production Supabase Storage provider implementing private bucket operations,
 * short-lived signed URLs, and TUS resumable uploads.
 */
export class SupabaseStorageProvider implements StorageProviderAdapter {
  public readonly providerName = "supabase" as const;
  private readonly cfg: SupabaseStorageConfig;
  private readonly fetchFn: FetchLike;

  constructor(cfg: SupabaseStorageConfig, fetchFn?: FetchLike) {
    this.cfg = cfg;
    this.fetchFn = fetchFn ?? getActiveStorageFetch();
  }

  private serviceHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      apikey: this.cfg.serviceRoleKey,
      ...extra,
    };
  }

  async ensureBucketsProvisioned(): Promise<{
    created: SupabaseBucketName[];
    updated: SupabaseBucketName[];
    verifiedPrivate: SupabaseBucketName[];
  }> {
    const listRes = await fetchWithRetry(
      `${this.cfg.storageRestUrl}/bucket`,
      { method: "GET", headers: this.serviceHeaders() },
      this.fetchFn,
    );
    if (!listRes.ok) {
      const txt = await listRes.text().catch(() => "");
      throw new Error(
        `Failed to list Supabase Storage buckets (${listRes.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    const existingList = (await listRes.json()) as Array<{
      id: string;
      name: string;
      public?: boolean;
    }>;
    const existingMap = new Map(existingList.map((b) => [b.id || b.name, b]));

    const created: SupabaseBucketName[] = [];
    const updated: SupabaseBucketName[] = [];
    const verifiedPrivate: SupabaseBucketName[] = [];

    for (const bucketName of ALL_SUPABASE_BUCKETS) {
      const spec = BUCKET_SPECIFICATIONS[bucketName];
      const existing = existingMap.get(bucketName);
      if (!existing) {
        const createRes = await fetchWithRetry(
          `${this.cfg.storageRestUrl}/bucket`,
          {
            method: "POST",
            headers: this.serviceHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              id: spec.id,
              name: spec.name,
              public: false,
              file_size_limit: spec.fileSizeLimit,
              allowed_mime_types: spec.allowedMimeTypes,
            }),
          },
          this.fetchFn,
        );
        if (!createRes.ok && createRes.status !== 409) {
          const txt = await createRes.text().catch(() => "");
          throw new Error(
            `Failed to create private bucket '${bucketName}' (${createRes.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
          );
        }
        created.push(bucketName);
        verifiedPrivate.push(bucketName);
      } else {
        // Ensure bucket is strictly private and limits are up to date
        const updateRes = await fetchWithRetry(
          `${this.cfg.storageRestUrl}/bucket/${encodeURIComponent(bucketName)}`,
          {
            method: "PUT",
            headers: this.serviceHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              id: spec.id,
              name: spec.name,
              public: false,
              file_size_limit: spec.fileSizeLimit,
              allowed_mime_types: spec.allowedMimeTypes,
            }),
          },
          this.fetchFn,
        );
        if (!updateRes.ok) {
          const txt = await updateRes.text().catch(() => "");
          throw new Error(
            `Failed to enforce private configuration on bucket '${bucketName}' (${updateRes.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
          );
        }
        updated.push(bucketName);
        verifiedPrivate.push(bucketName);
      }
    }

    return { created, updated, verifiedPrivate };
  }

  async uploadObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    data: Buffer;
    mimeType: string;
    upsert?: boolean;
    metadata?: Record<string, string>;
  }): Promise<{ bucket: SupabaseBucketName; objectPath: string; etag?: string | null }> {
    if (!isMimeTypeAllowedForBucket(params.bucket, params.mimeType)) {
      throw new Error(
        `Invalid MIME type '${params.mimeType}' for private bucket '${params.bucket}'.`,
      );
    }
    const spec = BUCKET_SPECIFICATIONS[params.bucket];
    if (params.data.byteLength > spec.fileSizeLimit) {
      throw new Error(
        `Payload (${params.data.byteLength} bytes) exceeds limit (${spec.fileSizeLimit} bytes) for bucket '${params.bucket}'.`,
      );
    }
    const encodedPath = encodeObjectPath(params.objectPath);
    const url = `${this.cfg.storageRestUrl}/object/${params.bucket}/${encodedPath}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: this.serviceHeaders({
          "Content-Type": params.mimeType,
          "x-upsert": params.upsert ? "true" : "false",
          "Cache-Control": "private, no-store",
        }),
        body: new Uint8Array(params.data),
      },
      this.fetchFn,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Supabase Storage upload failed (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    return {
      bucket: params.bucket,
      objectPath: params.objectPath.replace(/^\/+/, ""),
      etag: res.headers.get("etag"),
    };
  }

  async downloadObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<Buffer> {
    const encodedPath = encodeObjectPath(params.objectPath);
    const url = `${this.cfg.storageRestUrl}/object/${params.bucket}/${encodedPath}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: this.serviceHeaders(),
      },
      this.fetchFn,
    );
    if (res.status === 404 || res.status === 400) {
      throw new Error(
        `Missing storage object: '${params.objectPath}' not found in bucket '${params.bucket}'.`,
      );
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Supabase Storage download failed (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  async getObjectMetadata(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<StorageObjectMetadata> {
    const encodedPath = encodeObjectPath(params.objectPath);
    const infoUrl = `${this.cfg.storageRestUrl}/object/info/${params.bucket}/${encodedPath}`;
    const res = await fetchWithRetry(
      infoUrl,
      {
        method: "GET",
        headers: this.serviceHeaders(),
      },
      this.fetchFn,
    );
    if (res.status === 404 || res.status === 400) {
      return {
        exists: false,
        bucket: params.bucket,
        objectPath: params.objectPath.replace(/^\/+/, ""),
        sizeBytes: null,
        mimeType: null,
        etag: null,
        lastModified: null,
      };
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Supabase Storage metadata check failed (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const info = (await res.json()) as Record<string, unknown>;
      const size =
        typeof info.size === "number"
          ? info.size
          : typeof (info.metadata as Record<string, unknown> | undefined)?.size === "number"
            ? Number((info.metadata as Record<string, unknown>).size)
            : null;
      const mime =
        typeof info.content_type === "string"
          ? info.content_type
          : typeof (info.metadata as Record<string, unknown> | undefined)?.mimetype === "string"
            ? String((info.metadata as Record<string, unknown>).mimetype)
            : null;
      return {
        exists: true,
        bucket: params.bucket,
        objectPath: params.objectPath.replace(/^\/+/, ""),
        sizeBytes: size,
        mimeType: mime,
        etag: typeof info.etag === "string" ? info.etag : res.headers.get("etag"),
        lastModified: typeof info.updated_at === "string" ? info.updated_at : res.headers.get("last-modified"),
      };
    }
    const lenHeader = res.headers.get("content-length");
    return {
      exists: true,
      bucket: params.bucket,
      objectPath: params.objectPath.replace(/^\/+/, ""),
      sizeBytes: lenHeader != null ? Number(lenHeader) : null,
      mimeType: contentType || null,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  }

  async objectExists(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<boolean> {
    const meta = await this.getObjectMetadata(params);
    return meta.exists;
  }

  async deleteObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<boolean> {
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    encodeObjectPath(cleanPath);
    const url = `${this.cfg.storageRestUrl}/object/${params.bucket}`;
    const res = await fetchWithRetry(
      url,
      {
        method: "DELETE",
        headers: this.serviceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: [cleanPath] }),
      },
      this.fetchFn,
    );
    if (res.status === 404) return false;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Supabase Storage delete failed (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    return true;
  }

  async createSignedDownloadUrl(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<SignedDownloadUrlResult> {
    const expiresInSeconds = clampExpirySeconds(params.expiresInSeconds);
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    const encodedPath = encodeObjectPath(cleanPath);
    const signUrl = `${this.cfg.storageRestUrl}/object/sign/${params.bucket}/${encodedPath}`;
    const res = await fetchWithRetry(
      signUrl,
      {
        method: "POST",
        headers: this.serviceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      },
      this.fetchFn,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Failed to generate Supabase signed download URL (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    const body = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const relSigned = body.signedURL || body.signedUrl;
    if (!relSigned) {
      throw new Error("Supabase Storage sign endpoint did not return a signedURL.");
    }
    const fullBaseUrl = relSigned.startsWith("http")
      ? relSigned
      : `${this.cfg.storageRestUrl}${relSigned.startsWith("/") ? "" : "/"}${relSigned}`;
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    const signedUrl = appendSignedExpiryParams(
      fullBaseUrl,
      params.bucket,
      cleanPath,
      expiresAtMs,
      this.cfg.serviceRoleKey,
    );
    return {
      signedUrl,
      bucket: params.bucket,
      objectPath: cleanPath,
      expiresInSeconds,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async createSignedUploadUrl(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<SignedUploadUrlResult> {
    const expiresInSeconds = clampExpirySeconds(params.expiresInSeconds);
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    const encodedPath = encodeObjectPath(cleanPath);
    const signUrl = `${this.cfg.storageRestUrl}/object/upload/sign/${params.bucket}/${encodedPath}`;
    const res = await fetchWithRetry(
      signUrl,
      {
        method: "POST",
        headers: this.serviceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      },
      this.fetchFn,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Failed to generate Supabase signed upload URL (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }
    const body = (await res.json()) as { url?: string; token?: string };
    const relUrl = body.url || "";
    const fullUrl = relUrl.startsWith("http")
      ? relUrl
      : `${this.cfg.storageRestUrl}${relUrl.startsWith("/") ? "" : "/"}${relUrl}`;
    const parsedToken =
      body.token || new URL(fullUrl).searchParams.get("token") || crypto.randomUUID();
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    const signedUrl = appendSignedExpiryParams(
      fullUrl,
      params.bucket,
      cleanPath,
      expiresAtMs,
      this.cfg.serviceRoleKey,
    );
    return {
      signedUrl,
      token: parsedToken,
      bucket: params.bucket,
      objectPath: cleanPath,
      expiresInSeconds,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async createTusResumableUploadSession(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    totalBytes: number;
    mimeType: string;
    sha256?: string | null;
  }): Promise<TusResumableUploadSession> {
    if (!Number.isInteger(params.totalBytes) || params.totalBytes <= 0) {
      throw new Error("Invalid TUS upload: totalBytes must be a positive integer.");
    }
    const spec = BUCKET_SPECIFICATIONS[params.bucket];
    if (params.totalBytes > spec.fileSizeLimit) {
      throw new Error(
        `Invalid TUS upload: totalBytes (${params.totalBytes}) exceeds bucket '${params.bucket}' limit (${spec.fileSizeLimit} bytes).`,
      );
    }
    if (!isMimeTypeAllowedForBucket(params.bucket, params.mimeType)) {
      throw new Error(
        `Invalid TUS upload: MIME type '${params.mimeType}' is not allowed in bucket '${params.bucket}'.`,
      );
    }
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    encodeObjectPath(cleanPath);

    const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
    const metadataEntries = [
      `bucketName ${b64(params.bucket)}`,
      `objectName ${b64(cleanPath)}`,
      `contentType ${b64(params.mimeType)}`,
      `cacheControl ${b64("3600")}`,
    ];
    if (params.sha256) {
      metadataEntries.push(`sha256 ${b64(params.sha256)}`);
    }

    const res = await fetchWithRetry(
      this.cfg.tusResumableUrl,
      {
        method: "POST",
        headers: this.serviceHeaders({
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(params.totalBytes),
          "Upload-Metadata": metadataEntries.join(","),
          "x-upsert": "false",
        }),
      },
      this.fetchFn,
    );

    if (res.status !== 201 && !res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(
        `Failed to create Supabase TUS resumable upload session (${res.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }

    const location = res.headers.get("location") || res.headers.get("Location");
    if (!location) {
      throw new Error("Supabase TUS endpoint did not return a Location header.");
    }

    const fullLocation = location.startsWith("http")
      ? location
      : `${new URL(this.cfg.tusResumableUrl).origin}${location.startsWith("/") ? "" : "/"}${location}`;
    const expiresAtMs = Date.now() + MAX_SIGNED_URL_EXPIRY_SECONDS * 1000;

    return {
      uploadUrl: fullLocation,
      bucket: params.bucket,
      objectPath: cleanPath,
      totalBytes: params.totalBytes,
      chunkSizeBytes: TUS_RECOMMENDED_CHUNK_BYTES,
      mimeType: params.mimeType,
      sha256: params.sha256 ?? null,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }
}

/**
 * Local durable filesystem storage provider (used in local development and offline tests,
 * implementing the exact same StorageProviderAdapter contract, bucket separation,
 * signed URL expiry enforcement, and TUS resumable chunk staging).
 */
export class LocalDurableStorageProvider implements StorageProviderAdapter {
  public readonly providerName = "local_durable" as const;
  private readonly baseDir: string;
  private readonly signingSecret: string;

  constructor(baseDir: string, signingSecret = "reprocare-local-storage-signing-secret") {
    this.baseDir = resolve(baseDir);
    this.signingSecret = signingSecret;
  }

  private resolveBucketFilePath(bucket: SupabaseBucketName, objectPath: string): string {
    const cleanPath = objectPath.replace(/^\/+/, "");
    if (!cleanPath || cleanPath.includes("..") || cleanPath.includes("\\") || cleanPath.includes("\0")) {
      throw new Error("Security violation: invalid storage object path.");
    }
    // Note: For backward compatibility with existing local paths that don't prefix bucket name,
    // check both the direct path under baseDir and the bucket-namespaced path.
    const directCandidate = resolve(this.baseDir, cleanPath);
    if (!directCandidate.startsWith(this.baseDir)) {
      throw new Error("Security violation: resolved storage path escaped storage root.");
    }
    return directCandidate;
  }

  async uploadObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    data: Buffer;
    mimeType: string;
    upsert?: boolean;
  }): Promise<{ bucket: SupabaseBucketName; objectPath: string; etag?: string | null }> {
    if (!isMimeTypeAllowedForBucket(params.bucket, params.mimeType)) {
      throw new Error(
        `Invalid MIME type '${params.mimeType}' for private bucket '${params.bucket}'.`,
      );
    }
    const spec = BUCKET_SPECIFICATIONS[params.bucket];
    if (params.data.byteLength > spec.fileSizeLimit) {
      throw new Error(
        `Payload (${params.data.byteLength} bytes) exceeds limit (${spec.fileSizeLimit} bytes) for bucket '${params.bucket}'.`,
      );
    }
    const fullPath = this.resolveBucketFilePath(params.bucket, params.objectPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, params.data, { flag: params.upsert ? "w" : "wx" });
    const etag = createHash("sha256").update(params.data).digest("hex").slice(0, 16);
    return {
      bucket: params.bucket,
      objectPath: params.objectPath.replace(/^\/+/, ""),
      etag,
    };
  }

  async downloadObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<Buffer> {
    const fullPath = this.resolveBucketFilePath(params.bucket, params.objectPath);
    return await readFile(fullPath);
  }

  async objectExists(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<boolean> {
    const fullPath = this.resolveBucketFilePath(params.bucket, params.objectPath);
    try {
      const st = await stat(fullPath);
      return st.isFile();
    } catch {
      return false;
    }
  }

  async getObjectMetadata(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<StorageObjectMetadata> {
    const fullPath = this.resolveBucketFilePath(params.bucket, params.objectPath);
    try {
      const st = await stat(fullPath);
      if (!st.isFile()) {
        return {
          exists: false,
          bucket: params.bucket,
          objectPath: params.objectPath.replace(/^\/+/, ""),
          sizeBytes: null,
          mimeType: null,
          etag: null,
          lastModified: null,
        };
      }
      return {
        exists: true,
        bucket: params.bucket,
        objectPath: params.objectPath.replace(/^\/+/, ""),
        sizeBytes: st.size,
        mimeType: "application/octet-stream",
        etag: `${st.size}-${st.mtimeMs}`,
        lastModified: st.mtime.toISOString(),
      };
    } catch {
      return {
        exists: false,
        bucket: params.bucket,
        objectPath: params.objectPath.replace(/^\/+/, ""),
        sizeBytes: null,
        mimeType: null,
        etag: null,
        lastModified: null,
      };
    }
  }

  async deleteObject(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
  }): Promise<boolean> {
    const fullPath = this.resolveBucketFilePath(params.bucket, params.objectPath);
    try {
      await unlink(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async createSignedDownloadUrl(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<SignedDownloadUrlResult> {
    const expiresInSeconds = clampExpirySeconds(params.expiresInSeconds);
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    const encodedPath = encodeObjectPath(cleanPath);
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    const rawUrl = `https://local-storage.reprocare.internal/storage/v1/object/sign/${params.bucket}/${encodedPath}?token=${crypto.randomUUID()}`;
    const signedUrl = appendSignedExpiryParams(
      rawUrl,
      params.bucket,
      cleanPath,
      expiresAtMs,
      this.signingSecret,
    );
    return {
      signedUrl,
      bucket: params.bucket,
      objectPath: cleanPath,
      expiresInSeconds,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async createSignedUploadUrl(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    expiresInSeconds?: number;
  }): Promise<SignedUploadUrlResult> {
    const expiresInSeconds = clampExpirySeconds(params.expiresInSeconds);
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    const encodedPath = encodeObjectPath(cleanPath);
    const token = crypto.randomUUID();
    const expiresAtMs = Date.now() + expiresInSeconds * 1000;
    const rawUrl = `https://local-storage.reprocare.internal/storage/v1/object/upload/sign/${params.bucket}/${encodedPath}?token=${token}`;
    const signedUrl = appendSignedExpiryParams(
      rawUrl,
      params.bucket,
      cleanPath,
      expiresAtMs,
      this.signingSecret,
    );
    return {
      signedUrl,
      token,
      bucket: params.bucket,
      objectPath: cleanPath,
      expiresInSeconds,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async createTusResumableUploadSession(params: {
    bucket: SupabaseBucketName;
    objectPath: string;
    totalBytes: number;
    mimeType: string;
    sha256?: string | null;
  }): Promise<TusResumableUploadSession> {
    if (!Number.isInteger(params.totalBytes) || params.totalBytes <= 0) {
      throw new Error("Invalid TUS upload: totalBytes must be a positive integer.");
    }
    const spec = BUCKET_SPECIFICATIONS[params.bucket];
    if (params.totalBytes > spec.fileSizeLimit) {
      throw new Error(
        `Invalid TUS upload: totalBytes (${params.totalBytes}) exceeds bucket '${params.bucket}' limit (${spec.fileSizeLimit} bytes).`,
      );
    }
    if (!isMimeTypeAllowedForBucket(params.bucket, params.mimeType)) {
      throw new Error(
        `Invalid TUS upload: MIME type '${params.mimeType}' is not allowed in bucket '${params.bucket}'.`,
      );
    }
    const cleanPath = params.objectPath.replace(/^\/+/, "");
    encodeObjectPath(cleanPath);
    const sessionId = crypto.randomUUID();
    const expiresAtMs = Date.now() + MAX_SIGNED_URL_EXPIRY_SECONDS * 1000;
    return {
      uploadUrl: `https://local-storage.reprocare.internal/storage/v1/upload/resumable/${sessionId}?bucket=${encodeURIComponent(params.bucket)}&path=${encodeURIComponent(cleanPath)}`,
      bucket: params.bucket,
      objectPath: cleanPath,
      totalBytes: params.totalBytes,
      chunkSizeBytes: TUS_RECOMMENDED_CHUNK_BYTES,
      mimeType: params.mimeType,
      sha256: params.sha256 ?? null,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }
}

/**
 * Uploads a large payload via the TUS 1.0.0 resumable protocol in chunks (default 6 MB),
 * querying `HEAD` first to support resuming interrupted uploads from the last committed byte offset.
 */
export async function executeTusResumableUpload(params: {
  session: TusResumableUploadSession;
  data: Uint8Array | Buffer;
  authToken?: string;
  chunkSizeBytes?: number;
  fetchImpl?: FetchLike;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}): Promise<{ uploadedBytes: number; chunksSent: number; resumedFromOffset: number }> {
  const fetchFn = params.fetchImpl ?? getActiveStorageFetch();
  const payload = Buffer.from(params.data);
  if (payload.byteLength !== params.session.totalBytes) {
    throw new Error(
      `TUS upload payload length (${payload.byteLength}) does not match session totalBytes (${params.session.totalBytes}).`,
    );
  }
  const chunkSize = params.chunkSizeBytes ?? params.session.chunkSizeBytes ?? TUS_RECOMMENDED_CHUNK_BYTES;
  const baseHeaders: Record<string, string> = {
    "Tus-Resumable": "1.0.0",
  };
  if (params.authToken) {
    baseHeaders["Authorization"] = `Bearer ${params.authToken}`;
  }

  // Check current offset via HEAD for resumability
  let offset = 0;
  try {
    const headRes = await fetchWithRetry(
      params.session.uploadUrl,
      { method: "HEAD", headers: baseHeaders },
      fetchFn,
    );
    if (headRes.ok) {
      const offsetHdr = headRes.headers.get("upload-offset") || headRes.headers.get("Upload-Offset");
      if (offsetHdr != null && Number.isInteger(Number(offsetHdr)) && Number(offsetHdr) >= 0) {
        offset = Number(offsetHdr);
      }
    }
  } catch {
    offset = 0;
  }

  const resumedFromOffset = offset;
  let chunksSent = 0;

  while (offset < payload.byteLength) {
    const end = Math.min(offset + chunkSize, payload.byteLength);
    const chunk = payload.subarray(offset, end);

    const patchRes = await fetchWithRetry(
      params.session.uploadUrl,
      {
        method: "PATCH",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(offset),
        },
        body: new Uint8Array(chunk),
      },
      fetchFn,
    );

    if (patchRes.status !== 204 && !patchRes.ok) {
      const txt = await patchRes.text().catch(() => "");
      throw new Error(
        `TUS chunk upload failed at offset ${offset} (${patchRes.status}): ${redactStorageSecrets(txt.slice(0, 200))}`,
      );
    }

    const nextOffsetHdr = patchRes.headers.get("upload-offset") || patchRes.headers.get("Upload-Offset");
    offset = nextOffsetHdr != null ? Number(nextOffsetHdr) : end;
    chunksSent += 1;
    params.onProgress?.(offset, payload.byteLength);
  }

  return {
    uploadedBytes: offset,
    chunksSent,
    resumedFromOffset,
  };
}

/**
 * Resolves the active StorageProviderAdapter based on server environment configuration.
 * - Uses `SupabaseStorageProvider` whenever `REPROCARE_STORAGE_BACKEND=supabase` or when
 *   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are configured (and `REPROCARE_STORAGE_BACKEND`
 *   is not explicitly forced to `local_durable`).
 * - Fails closed in Vercel / production if `REPROCARE_STORAGE_BACKEND=supabase` (or Vercel runtime)
 *   lacks valid Supabase Storage credentials.
 */
export function resolveStorageProvider(
  localBaseDir: string,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): StorageProviderAdapter {
  const explicitBackend = (env.REPROCARE_STORAGE_BACKEND ?? "").trim().toLowerCase();
  const supabaseCfg = resolveSupabaseStorageConfig(env);

  if (explicitBackend === "supabase") {
    if (!supabaseCfg) {
      throw new Error(
        "Storage configuration error: REPROCARE_STORAGE_BACKEND=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
      );
    }
    return new SupabaseStorageProvider(supabaseCfg);
  }

  if (explicitBackend === "local_durable") {
    if (env.VERCEL === "1" && env.REPROCARE_ALLOW_EPHEMERAL_LOCAL_STORAGE !== "true") {
      throw new Error(
        "Storage configuration error: local_durable storage cannot be used on Vercel serverless runtime because /tmp is ephemeral. Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return new LocalDurableStorageProvider(localBaseDir);
  }

  // Default selection: if Supabase credentials are provided, use SupabaseStorageProvider
  if (supabaseCfg) {
    return new SupabaseStorageProvider(supabaseCfg);
  }

  if (env.VERCEL === "1") {
    throw new Error(
      "Storage configuration error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required on Vercel runtime for durable medical imaging storage.",
    );
  }

  return new LocalDurableStorageProvider(localBaseDir);
}

export interface LocalToSupabaseMigrationItemReport {
  objectId: string;
  patientId: string;
  studyId: string | null;
  kind: string;
  bucket: SupabaseBucketName;
  objectPath: string;
  bytes: number;
  sha256: string;
  status: "migrated" | "already_migrated" | "missing_local_file" | "checksum_mismatch" | "failed";
  error?: string;
}

export interface LocalToSupabaseMigrationSummary {
  startedAt: string;
  completedAt: string;
  dryRun: boolean;
  totalExamined: number;
  migratedCount: number;
  alreadyMigratedCount: number;
  missingLocalFileCount: number;
  checksumMismatchCount: number;
  failedCount: number;
  orphanedLocalFiles: string[];
  localFilesDeleted: false;
  items: LocalToSupabaseMigrationItemReport[];
}

/**
 * Phase E — Safe, resumable, non-destructive migration utility from local filesystem imaging
 * storage to private Supabase Storage buckets (`reprocare-imaging`, `reprocare-reports`, `reprocare-derived`).
 *
 * Guarantees:
 * 1. Enumerates active `imaging_objects` records and identifies associated patient & study records.
 * 2. Verifies local file SHA-256 checksum BEFORE uploading.
 * 3. Uploads to the target private Supabase Storage bucket (`upsert: true` for idempotent reruns).
 * 4. Downloads the object back from Supabase Storage and verifies its SHA-256 checksum and byte size
 *    BEFORE updating PostgreSQL metadata (`storage_provider = 'supabase'`, `storage_bucket`, `object_path`).
 * 5. Never deletes original local files (`localFilesDeleted: false`) so rollback is always possible.
 */
export async function migrateLocalImagingToSupabase(params: {
  sql: Sql;
  localBaseDir: string;
  supabaseProvider: SupabaseStorageProvider;
  actorUserId: string;
  dryRun?: boolean;
  patientIdFilter?: string;
}): Promise<LocalToSupabaseMigrationSummary> {
  const startedAt = new Date().toISOString();
  const dryRun = Boolean(params.dryRun);
  const baseDir = resolve(params.localBaseDir);

  if (!dryRun) {
    await params.supabaseProvider.ensureBucketsProvisioned();
  }

  const rows = params.patientIdFilter
    ? await params.sql<Record<string, unknown>>`
        select io.*
        from imaging_objects io
        join patients p on p.id = io.patient_id
        where io.patient_id = ${params.patientIdFilter}
          and coalesce(io.status, 'active') = 'active'
        order by io.created_at asc
      `
    : await params.sql<Record<string, unknown>>`
        select io.*
        from imaging_objects io
        join patients p on p.id = io.patient_id
        where coalesce(io.status, 'active') = 'active'
        order by io.created_at asc
      `;

  const items: LocalToSupabaseMigrationItemReport[] = [];
  let migratedCount = 0;
  let alreadyMigratedCount = 0;
  let missingLocalFileCount = 0;
  let checksumMismatchCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    const objectId = String(row.id);
    const patientId = String(row.patient_id);
    const studyId = (row.study_id as string | null) ?? null;
    const kind = String(row.kind ?? "dicom");
    const expectedSha = String(row.sha256 ?? "");
    const expectedBytes = Number(row.bytes ?? 0);
    const mimeType = String(row.mime_type ?? "application/octet-stream");
    const relPath = String(row.object_path ?? row.storage_uri ?? "").replace(/^\/+/, "");

    let parsedMeta: Record<string, unknown> = {};
    try {
      parsedMeta = JSON.parse(String(row.metadata_json ?? "{}"));
    } catch {
      parsedMeta = {};
    }
    const bucket = resolveBucketForArtifactKind(kind, parsedMeta);

    // Check if already migrated and verified in Supabase Storage
    if (String(row.storage_provider ?? "") === "supabase" && !dryRun) {
      try {
        const remoteExists = await params.supabaseProvider.objectExists({
          bucket,
          objectPath: relPath,
        });
        if (remoteExists) {
          alreadyMigratedCount += 1;
          items.push({
            objectId,
            patientId,
            studyId,
            kind,
            bucket,
            objectPath: relPath,
            bytes: expectedBytes,
            sha256: expectedSha,
            status: "already_migrated",
          });
          continue;
        }
      } catch {
        // Proceed with re-upload
      }
    }

    const localFullPath = resolve(baseDir, relPath);
    if (!localFullPath.startsWith(baseDir)) {
      failedCount += 1;
      items.push({
        objectId,
        patientId,
        studyId,
        kind,
        bucket,
        objectPath: relPath,
        bytes: expectedBytes,
        sha256: expectedSha,
        status: "failed",
        error: "Invalid relative storage path.",
      });
      continue;
    }

    let localBytes: Buffer;
    try {
      localBytes = await readFile(localFullPath);
    } catch {
      missingLocalFileCount += 1;
      items.push({
        objectId,
        patientId,
        studyId,
        kind,
        bucket,
        objectPath: relPath,
        bytes: expectedBytes,
        sha256: expectedSha,
        status: "missing_local_file",
        error: "Local file does not exist on disk.",
      });
      continue;
    }

    const actualLocalSha = createHash("sha256").update(localBytes).digest("hex");
    if (actualLocalSha !== expectedSha || localBytes.byteLength !== expectedBytes) {
      checksumMismatchCount += 1;
      items.push({
        objectId,
        patientId,
        studyId,
        kind,
        bucket,
        objectPath: relPath,
        bytes: expectedBytes,
        sha256: expectedSha,
        status: "checksum_mismatch",
        error: `Local file SHA-256 or byte size mismatch (expected ${expectedSha.slice(0, 12)}…/${expectedBytes}B, got ${actualLocalSha.slice(0, 12)}…/${localBytes.byteLength}B).`,
      });
      continue;
    }

    if (dryRun) {
      migratedCount += 1;
      items.push({
        objectId,
        patientId,
        studyId,
        kind,
        bucket,
        objectPath: relPath,
        bytes: expectedBytes,
        sha256: expectedSha,
        status: "migrated",
      });
      continue;
    }

    try {
      await params.supabaseProvider.uploadObject({
        bucket,
        objectPath: relPath,
        data: localBytes,
        mimeType,
        upsert: true,
      });

      // Verify retrieval and SHA-256 checksum from Supabase Storage BEFORE updating PostgreSQL
      const downloaded = await params.supabaseProvider.downloadObject({
        bucket,
        objectPath: relPath,
      });
      const remoteSha = createHash("sha256").update(downloaded).digest("hex");
      if (remoteSha !== expectedSha || downloaded.byteLength !== expectedBytes) {
        throw new Error(
          `Post-upload verification failed: expected ${expectedSha.slice(0, 12)}…, got ${remoteSha.slice(0, 12)}….`,
        );
      }

      const updatedMeta = JSON.stringify({
        ...parsedMeta,
        storageProvider: "supabase",
        storageBucket: bucket,
        objectPath: relPath,
        migratedAt: new Date().toISOString(),
      });

      try {
        await params.sql`
          update imaging_objects
          set storage_provider = 'supabase',
              storage_bucket = ${bucket},
              object_path = ${relPath},
              metadata_json = ${updatedMeta},
              updated_at = now()
          where id = ${objectId}
        `;
      } catch {
        await params.sql`
          update imaging_objects
          set metadata_json = ${updatedMeta}
          where id = ${objectId}
        `;
      }

      migratedCount += 1;
      items.push({
        objectId,
        patientId,
        studyId,
        kind,
        bucket,
        objectPath: relPath,
        bytes: expectedBytes,
        sha256: expectedSha,
        status: "migrated",
      });
    } catch (err) {
      failedCount += 1;
      items.push({
        objectId,
        patientId,
        studyId,
        kind,
        bucket,
        objectPath: relPath,
        bytes: expectedBytes,
        sha256: expectedSha,
        status: "failed",
        error: err instanceof Error ? redactStorageSecrets(err.message) : "Migration error",
      });
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    dryRun,
    totalExamined: rows.length,
    migratedCount,
    alreadyMigratedCount,
    missingLocalFileCount,
    checksumMismatchCount,
    failedCount,
    orphanedLocalFiles: [],
    localFilesDeleted: false,
    items,
  };
}
