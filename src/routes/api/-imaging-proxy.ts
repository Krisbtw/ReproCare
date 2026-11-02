/**
 * Server-side proxy for the optional Python imaging service (imaging-service/, FastAPI).
 *
 * Exposes type-safe TanStack Start server functions to the frontend without leaking
 * secrets or internal service topologies into public client bundles.
 */
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "../../lib/auth/middleware.ts";
import {
  imagingServiceUrl,
  resolveImagingServiceEndpoint,
  requireClinicianOrAdmin,
  serviceHeaders,
  auditProxyAction,
  proxyFetch,
} from "../../lib/imaging/proxy.server.ts";



const MAX_PROXY_FILES = 1000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64MB

export type ProxyModelStatus = {
  id: string;
  name: string;
  connected: boolean;
  reason: string;
  modality?: string;
  intended_structures?: string[];
  licence_note?: string;
  is_learned_model: boolean;
  label_map?: Record<string, string> | null;
  architecture?: string;
  model_version?: string | null;
  dataset_version?: string | null;
  checkpoint_sha256?: string | null;
  training_mode?: string | null;
  is_clinical_grade?: boolean;
  trained_at?: string | null;
  validation_metrics?: Record<string, any> | null;
};

export type ProxyFile = { name: string; base64: string };

/** List available segmentation models. Requires verified clinician or administrator credentials. */
export const proxyListModels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await requireClinicianOrAdmin(context.userId);
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
    return (await res.json()) as ProxyModelStatus[];
  });

/** Forward a DICOM series to the Python /series/inspect endpoint. Requires verified clinician/admin. */
export const proxyInspectSeries = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    if (!Array.isArray(input)) throw new Error("Expected an array of file objects.");
    if (input.length === 0) throw new Error("At least one DICOM file is required.");
    if (input.length > MAX_PROXY_FILES) throw new Error(`Exceeded maximum file limit of ${MAX_PROXY_FILES}.`);
    let estimatedBytes = 0;
    for (const f of input) {
      if (!f || typeof f !== "object") throw new Error("Each file must be an object.");
      const o = f as Record<string, unknown>;
      if (typeof o["name"] !== "string" || typeof o["base64"] !== "string") {
        throw new Error("Each file must have name:string and base64:string.");
      }
      estimatedBytes += Math.floor((o["base64"].length * 3) / 4);
    }
    if (estimatedBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Payload exceeds maximum allowed size of ${MAX_TOTAL_BYTES / (1024 * 1024)}MB.`);
    }
    return input as ProxyFile[];
  })
  .handler(async ({ data: files, context }) => {
    await requireClinicianOrAdmin(context.userId);
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
    await auditProxyAction(context.userId, "proxy_inspect_series", `Inspected ${files.length} slices`);
    const text = await res.text();
    return text;
  });

/** Forward a DICOM series to the Python /segment/{modelId} endpoint. Requires verified clinician/admin. */
export const proxySegment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    if (!input || typeof input !== "object") throw new Error("Expected an object.");
    const o = input as Record<string, unknown>;
    if (typeof o["modelId"] !== "string" || !o["modelId"].trim()) throw new Error("modelId must be a non-empty string.");
    if (!Array.isArray(o["files"])) throw new Error("files must be an array.");
    if (o["files"].length === 0) throw new Error("At least one DICOM file is required.");
    if (o["files"].length > MAX_PROXY_FILES) throw new Error(`Exceeded maximum file limit of ${MAX_PROXY_FILES}.`);
    let estimatedBytes = 0;
    for (const f of o["files"] as unknown[]) {
      if (!f || typeof f !== "object") throw new Error("Each file must be an object.");
      const ff = f as Record<string, unknown>;
      if (typeof ff["name"] !== "string" || typeof ff["base64"] !== "string") {
        throw new Error("Each file must have name:string and base64:string.");
      }
      estimatedBytes += Math.floor((ff["base64"].length * 3) / 4);
    }
    if (estimatedBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Payload exceeds maximum allowed size of ${MAX_TOTAL_BYTES / (1024 * 1024)}MB.`);
    }
    return { modelId: o["modelId"] as string, files: o["files"] as ProxyFile[] };
  })
  .handler(async ({ data: { modelId, files }, context }) => {
    await requireClinicianOrAdmin(context.userId);
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
    await auditProxyAction(context.userId, "proxy_ai_segment", `Model: ${modelId}, slices: ${files.length}`);
    const text = await res.text();
    return text;
  });

/** Forward trend calculation request to the Python /trends/calculate endpoint. Requires verified clinician/admin. */
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
  .handler(async ({ data, context }) => {
    await requireClinicianOrAdmin(context.userId);
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
    await auditProxyAction(context.userId, "proxy_calculate_trends", `Observations: ${data.observations.length}`);
    const text = await res.text();
    return text;
  });
