/**
 * Server-side proxy for the optional Python imaging service (imaging-service/, FastAPI).
 *
 * WHY A PROXY?
 * The Python service requires an API key (ANATOMYBRIDGE_SERVICE_API_KEY). If the
 * frontend called the service directly, the key would have to be a VITE_* variable,
 * which Vite inlines into the public JS bundle — anyone viewing source would see it.
 *
 * This proxy keeps the key exclusively in server-side process.env. The browser
 * calls /api/imaging-proxy/* (same-origin, auth-gated), and this handler forwards
 * to the Python service with the server-held token. Nothing in the browser bundle
 * references ANATOMYBRIDGE_SERVICE_API_KEY.
 *
 * ENVIRONMENT VARIABLES (server-only — no VITE_ prefix):
 *   ANATOMYBRIDGE_SERVICE_URL          Base URL of the Python service, e.g. http://localhost:8100
 *   ANATOMYBRIDGE_SERVICE_API_KEY      Bearer token / API key for the service (optional when service
 *                                      runs without auth, e.g. local dev with no key set)
 *
 * ROUTES:
 *   GET  /api/imaging-proxy/models
 *   POST /api/imaging-proxy/inspect          (multipart, same schema as /series/inspect)
 *   POST /api/imaging-proxy/segment/:modelId (multipart, same schema as /segment/{model_id})
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

const PROXY_TIMEOUT_MS = 90_000;

function imagingServiceUrl(): string | null {
  const raw = process.env["ANATOMYBRIDGE_SERVICE_URL"];
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function imagingServiceKey(): string | null {
  const key = process.env["ANATOMYBRIDGE_SERVICE_API_KEY"];
  return key && key.trim().length > 0 ? key.trim() : null;
}

function serviceHeaders(): Record<string, string> {
  const key = imagingServiceKey();
  const h: Record<string, string> = {};
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

async function proxyFetch(
  path: string,
  init: RequestInit,
  timeoutMs = PROXY_TIMEOUT_MS,
): Promise<Response> {
  const base = imagingServiceUrl();
  if (!base) throw new Error("ANATOMYBRIDGE_SERVICE_URL is not configured on the server.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${base}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** List available segmentation models. */
export const proxyListModels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    let res: Response;
    try {
      res = await proxyFetch("/models", { method: "GET", headers: serviceHeaders() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Imaging service unreachable: ${msg}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Imaging service returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as string;
  });

/** Proxy type for inspect — accepts serialized FormData entries. */
export type ProxyFile = { name: string; base64: string };

/** Forward a DICOM series to the Python /series/inspect endpoint. */
export const proxyInspectSeries = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    if (!Array.isArray(input)) throw new Error("Expected an array of file objects.");
    for (const f of input) {
      if (!f || typeof f !== "object") throw new Error("Each file must be an object.");
      const o = f as Record<string, unknown>;
      if (typeof o["name"] !== "string" || typeof o["base64"] !== "string") {
        throw new Error("Each file must have name:string and base64:string.");
      }
    }
    return input as ProxyFile[];
  })
  .handler(async ({ data: files }) => {
    const form = new FormData();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      form.append(
        "files",
        new Blob([bytes.buffer], { type: "application/dicom" }),
        `slice-${String(i).padStart(4, "0")}.dcm`,
      );
    }
    let res: Response;
    try {
      res = await proxyFetch("/series/inspect", { method: "POST", headers: serviceHeaders(), body: form });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Imaging service unreachable: ${msg}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Imaging service returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    const text = await res.text();
    return text;
  });

/** Forward a DICOM series to the Python /segment/{modelId} endpoint. */
export const proxySegment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Expected an object.");
    const o = input as Record<string, unknown>;
    if (typeof o["modelId"] !== "string") throw new Error("modelId must be a string.");
    if (!Array.isArray(o["files"])) throw new Error("files must be an array.");
    for (const f of o["files"] as unknown[]) {
      if (!f || typeof f !== "object") throw new Error("Each file must be an object.");
      const ff = f as Record<string, unknown>;
      if (typeof ff["name"] !== "string" || typeof ff["base64"] !== "string") {
        throw new Error("Each file must have name:string and base64:string.");
      }
    }
    return { modelId: o["modelId"] as string, files: o["files"] as ProxyFile[] };
  })
  .handler(async ({ data: { modelId, files } }) => {
    const form = new FormData();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      form.append(
        "files",
        new Blob([bytes.buffer], { type: "application/dicom" }),
        `slice-${String(i).padStart(4, "0")}.dcm`,
      );
    }
    let res: Response;
    try {
      res = await proxyFetch(`/segment/${encodeURIComponent(modelId)}`, {
        method: "POST",
        headers: serviceHeaders(),
        body: form,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Imaging service unreachable: ${msg}`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail =
        body && typeof body === "object" && "detail" in body
          ? JSON.stringify((body as Record<string, unknown>)["detail"]).slice(0, 400)
          : res.statusText;
      throw new Error(`Imaging service returned ${res.status}: ${detail}`);
    }
    const text = await res.text();
    return text;
  });

/** Forward trend calculation request to the Python /trends/calculate endpoint. */
export const proxyCalculateTrends = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Expected an object.");
    return input as {
      observations: Array<{ date: string; volume_mm3: number }>;
      historical_findings?: Array<Record<string, unknown>>;
      current_findings?: Array<Record<string, unknown>>;
    };
  })
  .handler(async ({ data }) => {
    let res: Response;
    try {
      res = await proxyFetch("/trends/calculate", {
        method: "POST",
        headers: {
          ...serviceHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Imaging service unreachable: ${msg}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Imaging service returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    const text = await res.text();
    return text;
  });

