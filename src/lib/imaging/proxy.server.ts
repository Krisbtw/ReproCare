/**
 * Server-only execution logic for imaging service proxy.
 * Enforces unified clinician verification & administrator authorization.
 */
import { getSql, type Sql } from "../db.ts";
import { requireVerifiedClinicianOrAdmin } from "../clinic/server.backend.ts";

const PROXY_TIMEOUT_MS = 90_000;
const MAX_PROXY_FILES = 1000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64MB

export function imagingServiceUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env["ANATOMYBRIDGE_SERVICE_URL"] || env["IMAGING_SERVICE_URL"];
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function resolveImagingServiceEndpoint(
  path: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const base = imagingServiceUrl(env);
  if (!base) return null;
  const cleanRelativePath = path.replace(/^\/+/, "");
  return new URL(cleanRelativePath, `${base}/`).toString();
}

export function imagingServiceKey(): string | null {
  const key = process.env["ANATOMYBRIDGE_SERVICE_API_KEY"];
  return key && key.trim().length > 0 ? key.trim() : null;
}

export function serviceHeaders(): Record<string, string> {
  const key = imagingServiceKey();
  const h: Record<string, string> = {};
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

export async function requireClinicianOrAdmin(userId: string, sqlOverride?: Sql): Promise<string> {
  const sql = sqlOverride ?? (await getSql());
  const auth = await requireVerifiedClinicianOrAdmin(sql, userId, "imaging inspection and AI segmentation");
  return auth.effectiveRole;
}

export async function auditProxyAction(userId: string, action: string, detail: string) {
  try {
    const sql = await getSql();
    await sql`insert into audit_events (id, user_id, action, entity_type, entity_id, detail)
      values (${crypto.randomUUID()}, ${userId}, ${action}, 'imaging_proxy', ${userId}, ${detail})`;
  } catch {
    // Non-fatal logging
  }
}

export async function proxyFetch(
  path: string,
  init: RequestInit,
  timeoutMs = PROXY_TIMEOUT_MS,
): Promise<Response> {
  const targetUrl = resolveImagingServiceEndpoint(path);
  if (!targetUrl) throw new Error("ANATOMYBRIDGE_SERVICE_URL is not configured on the server.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
