#!/usr/bin/env node
/**
 * Phase E — Resumable, non-destructive CLI migration tool from local filesystem imaging storage
 * to private Supabase Storage buckets (`reprocare-imaging`, `reprocare-reports`, `reprocare-derived`).
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." \
 *   SUPABASE_URL="https://mfbqdesghtvalkywzsdb.supabase.co" \
 *   SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
 *   node scripts/migrate-storage-to-supabase.mjs [--dry-run] [--patient-id=<id>]
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMigrationConnectionConfig } from "./migrate.mjs";
import { provisionSupabaseBuckets } from "./setup-supabase-storage.mjs";

function mapKindToBucket(kind, meta = {}) {
  const k = String(kind || "").toLowerCase();
  if (k === "report" || k === "clinical_report") return "reprocare-reports";
  if (k === "mask" || k === "segmentation_mask" || k === "mesh" || k === "mesh_3d") {
    return "reprocare-derived";
  }
  if (k === "volume" && (meta.isDerived === true || Boolean(meta.sourceObjectId))) {
    return "reprocare-derived";
  }
  return "reprocare-imaging";
}

export async function runCliStorageMigration(env = process.env, args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const patientArg = args.find((a) => a.startsWith("--patient-id="));
  const patientIdFilter = patientArg ? patientArg.split("=")[1] : null;

  const dbCfg = resolveMigrationConnectionConfig(env);
  if (!dbCfg) {
    throw new Error("[migrate-storage] DATABASE_URL is required.");
  }
  const supabaseUrl = (env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      "[migrate-storage] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.",
    );
  }

  const localBase = resolve(
    env.REPROCARE_IMAGING_STORAGE_DIR || env.IMAGING_STORAGE_PATH || ".data/imaging",
  );

  if (!dryRun) {
    await provisionSupabaseBuckets(env);
  }

  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString: dbCfg.connectionString,
    ssl: dbCfg.ssl,
    max: 1,
  });

  try {
    const query = patientIdFilter
      ? {
          text: "SELECT * FROM imaging_objects WHERE patient_id = $1 AND COALESCE(status, 'active') = 'active' ORDER BY created_at ASC",
          values: [patientIdFilter],
        }
      : {
          text: "SELECT * FROM imaging_objects WHERE COALESCE(status, 'active') = 'active' ORDER BY created_at ASC",
          values: [],
        };
    const { rows } = await pool.query(query);
    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      const relPath = String(row.object_path || row.storage_uri || "").replace(/^\/+/, "");
      const fullLocalPath = resolve(localBase, relPath);
      if (!fullLocalPath.startsWith(localBase)) {
        failed += 1;
        continue;
      }
      let meta = {};
      try {
        meta = JSON.parse(String(row.metadata_json || "{}"));
      } catch {
        meta = {};
      }
      const bucket = mapKindToBucket(row.kind, meta);

      let bytes;
      try {
        bytes = await readFile(fullLocalPath);
      } catch {
        failed += 1;
        console.warn(`[migrate-storage] Missing local file for object ${row.id}`);
        continue;
      }

      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== row.sha256 || bytes.byteLength !== Number(row.bytes)) {
        failed += 1;
        console.warn(`[migrate-storage] Checksum mismatch for local object ${row.id}`);
        continue;
      }

      if (dryRun) {
        migrated += 1;
        continue;
      }

      const encodedPath = relPath.split("/").map(encodeURIComponent).join("/");
      const upRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "Content-Type": row.mime_type || "application/octet-stream",
          "x-upsert": "true",
        },
        body: new Uint8Array(bytes),
      });
      if (!upRes.ok) {
        failed += 1;
        console.warn(`[migrate-storage] Upload failed for object ${row.id} (HTTP ${upRes.status})`);
        continue;
      }

      const dlRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
      });
      if (!dlRes.ok) {
        failed += 1;
        continue;
      }
      const remoteBuf = Buffer.from(await dlRes.arrayBuffer());
      const remoteSha = createHash("sha256").update(remoteBuf).digest("hex");
      if (remoteSha !== row.sha256) {
        failed += 1;
        continue;
      }

      await pool.query(
        `UPDATE imaging_objects
         SET storage_provider = 'supabase',
             storage_bucket = $1,
             object_path = $2,
             updated_at = now()
         WHERE id = $3`,
        [bucket, relPath, row.id],
      );
      migrated += 1;
    }

    return { total: rows.length, migrated, skipped, failed, dryRun, localFilesDeleted: false };
  } finally {
    await pool.end();
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  runCliStorageMigration()
    .then((res) => {
      console.log(
        `[migrate-storage] Complete (dryRun=${res.dryRun}): examined=${res.total}, migrated=${res.migrated}, failed=${res.failed}, localFilesDeleted=${res.localFilesDeleted}`,
      );
      if (res.failed > 0) process.exit(1);
    })
    .catch((err) => {
      console.error("[migrate-storage] Error:", err.message || err);
      process.exit(1);
    });
}
