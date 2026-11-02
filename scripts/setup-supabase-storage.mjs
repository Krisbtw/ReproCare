#!/usr/bin/env node
/**
 * Controlled, repeatable provisioning script for ReproCare's private Supabase Storage buckets:
 *   - `reprocare-imaging`: Original DICOM files, DICOM studies, NIfTI volumes, MRI image data (512 MB limit)
 *   - `reprocare-reports`: Clinical PDF reports and supporting medical documents (64 MB limit)
 *   - `reprocare-derived`: Segmentation masks, 3D meshes, derived imaging volumes (256 MB limit)
 *
 * Usage:
 *   SUPABASE_URL="https://mfbqdesghtvalkywzsdb.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
 *   node scripts/setup-supabase-storage.mjs
 */
import { fileURLToPath } from "node:url";

export const PRIVATE_BUCKET_SPECS = [
  {
    id: "reprocare-imaging",
    name: "reprocare-imaging",
    public: false,
    file_size_limit: 512 * 1024 * 1024,
    allowed_mime_types: [
      "application/dicom",
      "application/octet-stream",
      "application/gzip",
      "application/x-gzip",
      "image/nii",
      "application/nii",
    ],
  },
  {
    id: "reprocare-reports",
    name: "reprocare-reports",
    public: false,
    file_size_limit: 64 * 1024 * 1024,
    allowed_mime_types: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "application/octet-stream",
    ],
  },
  {
    id: "reprocare-derived",
    name: "reprocare-derived",
    public: false,
    file_size_limit: 256 * 1024 * 1024,
    allowed_mime_types: [
      "application/octet-stream",
      "application/json",
      "model/stl",
      "model/obj",
      "text/plain",
    ],
  },
];

export async function provisionSupabaseBuckets(env = process.env, fetchImpl = fetch) {
  const supabaseUrl = (env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[setup-supabase-storage] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }
  if (/\[YOUR-|PLACEHOLDER/i.test(supabaseUrl) || /\[YOUR-|PLACEHOLDER/i.test(serviceRoleKey)) {
    throw new Error(
      "[setup-supabase-storage] Unreplaced credential placeholder detected in SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  const headers = {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    "Content-Type": "application/json",
  };

  const listRes = await fetchImpl(`${supabaseUrl}/storage/v1/bucket`, {
    method: "GET",
    headers,
  });
  if (!listRes.ok) {
    throw new Error(
      `[setup-supabase-storage] Failed to list buckets (HTTP ${listRes.status}).`,
    );
  }

  const existing = await listRes.json();
  const existingMap = new Map(existing.map((b) => [b.id || b.name, b]));
  const summary = { created: [], updated: [], verifiedPrivate: [] };

  for (const spec of PRIVATE_BUCKET_SPECS) {
    if (!existingMap.has(spec.id)) {
      const createRes = await fetchImpl(`${supabaseUrl}/storage/v1/bucket`, {
        method: "POST",
        headers,
        body: JSON.stringify(spec),
      });
      if (!createRes.ok && createRes.status !== 409) {
        throw new Error(
          `[setup-supabase-storage] Failed to create private bucket '${spec.id}' (HTTP ${createRes.status}).`,
        );
      }
      summary.created.push(spec.id);
      summary.verifiedPrivate.push(spec.id);
    } else {
      const updateRes = await fetchImpl(
        `${supabaseUrl}/storage/v1/bucket/${encodeURIComponent(spec.id)}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(spec),
        },
      );
      if (!updateRes.ok) {
        throw new Error(
          `[setup-supabase-storage] Failed to update private bucket '${spec.id}' (HTTP ${updateRes.status}).`,
        );
      }
      summary.updated.push(spec.id);
      summary.verifiedPrivate.push(spec.id);
    }
  }

  return summary;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  provisionSupabaseBuckets()
    .then((res) => {
      console.log(
        `[setup-supabase-storage] Success — verified private buckets: ${res.verifiedPrivate.join(", ")} (created: ${res.created.length}, updated: ${res.updated.length})`,
      );
    })
    .catch((err) => {
      console.error("[setup-supabase-storage] Error:", err.message || err);
      process.exit(1);
    });
}
