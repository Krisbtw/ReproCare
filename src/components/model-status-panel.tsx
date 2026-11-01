import { useEffect, useState } from "react";
import { proxyListModels, proxySegment, type ProxyModelStatus } from "@/routes/api/-imaging-proxy";
import type { Mask } from "@/lib/imaging/volume";

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function decompressZlibMask(b64: string): Promise<Uint8Array> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream("deflate"));
  if (!stream) throw new Error("DecompressionStream is not supported in this browser.");
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

export type AiSegmentSuccess = {
  labels: Record<string, string>;
  mask: Mask;
  model: { id: string; name: string; is_learned_model: boolean; weights?: string; command?: string };
  note: string;
  voxelCount: number;
  structureName: string;
};

export function ModelStatusPanel({
  seriesFiles = [],
  disabled = false,
  onSegmentSuccess,
}: {
  seriesFiles?: { name: string; bytes: Uint8Array }[];
  disabled?: boolean;
  onSegmentSuccess?: (result: AiSegmentSuccess) => void;
}) {
  const [models, setModels] = useState<ProxyModelStatus[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedClass, setSelectedClass] = useState<string>("3"); // 3 = myoma (uterine fibroid)
  const [loading, setLoading] = useState<boolean>(true);
  const [inferring, setInferring] = useState<boolean>(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [inferenceMessage, setInferenceMessage] = useState<{ tone: "clay" | "pine"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    async function fetchModels() {
      setLoading(true);
      setServiceError(null);
      try {
        const list = await proxyListModels();
        if (active) {
          setModels(list);
          if (list.length > 0 && !selectedModelId) {
            setSelectedModelId(list[0].id);
          }
        }
      } catch (err) {
        if (active) {
          const msg = err instanceof Error ? err.message : String(err);
          setServiceError(msg);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void fetchModels();
    return () => {
      active = false;
    };
  }, []);

  async function handleRunInference() {
    if (!selectedModelId || seriesFiles.length === 0) return;
    setInferring(true);
    setInferenceMessage(null);

    try {
      // Serialize files for server proxy
      const payloadFiles = seriesFiles.slice(0, 1000).map((f) => ({
        name: f.name,
        base64: uint8ToBase64(f.bytes),
      }));

      const rawResponse = await proxySegment({
        data: {
          modelId: selectedModelId,
          files: payloadFiles,
        },
      });

      const parsed = JSON.parse(rawResponse) as {
        labels: Record<string, string>;
        mask_b64_zlib?: string;
        shape_zyx?: [number, number, number];
        spacing_zyx_mm?: [number, number, number];
        model: { id: string; is_learned_model: boolean };
        note: string;
      };

      if (!parsed.mask_b64_zlib || !parsed.shape_zyx || !parsed.spacing_zyx_mm) {
        throw new Error("Model response was missing volumetric mask data.");
      }

      const decompressed = await decompressZlibMask(parsed.mask_b64_zlib);
      const [nz, ny, nx] = parsed.shape_zyx;
      const maskData = new Uint8Array(nx * ny * nz);
      const targetVal = Number(selectedClass);

      let targetCount = 0;
      for (let i = 0; i < decompressed.length; i++) {
        const val = decompressed[i];
        const match = targetVal === 0 ? (val > 0 ? 1 : 0) : (val === targetVal ? 1 : 0);
        maskData[i] = match;
        if (match) targetCount++;
      }

      const mask: Mask = {
        dims: [nx, ny, nz],
        spacingMm: [parsed.spacing_zyx_mm[2], parsed.spacing_zyx_mm[1], parsed.spacing_zyx_mm[0]],
        data: maskData,
      };

      const structureName = parsed.labels[selectedClass] || (targetVal === 0 ? "All structures" : `Class ${selectedClass}`);

      setInferenceMessage({
        tone: "pine",
        text: `${parsed.note || "Genuine learned model output. Not clinician-verified."} (${targetCount} voxels segmented for ${structureName})`,
      });

      if (onSegmentSuccess) {
        onSegmentSuccess({
          labels: parsed.labels,
          mask,
          model: { ...parsed.model, name: selectedModel?.name || selectedModelId },
          note: parsed.note,
          voxelCount: targetCount,
          structureName,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInferenceMessage({
        tone: "clay",
        text: `Inference refused: ${msg}`,
      });
    } finally {
      setInferring(false);
    }
  }

  const selectedModel = models.find((m) => m.id === selectedModelId);

  return (
    <div className="space-y-4 rounded-md border border-line bg-card p-4 text-sm" data-testid="model-status-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-ink">AI Segmentation Models (Optional Service)</h3>
        {loading ? (
          <span className="text-xs text-muted">Checking models…</span>
        ) : serviceError ? (
          <span className="inline-flex items-center rounded-sm bg-clay-soft px-2 py-0.5 text-xs font-medium text-clay">
            Service unavailable
          </span>
        ) : models.length > 0 ? (
          <span className="inline-flex items-center rounded-sm bg-paper px-2 py-0.5 text-xs text-ink-soft">
            {models.filter((m) => m.connected).length} of {models.length} connected
          </span>
        ) : null}
      </div>

      <div className="rounded-md bg-paper p-3 text-xs text-muted">
        <strong className="text-ink">Medical Safety Notice:</strong> This application never fabricates AI segmentation
        masks. If trained model weights are missing or not configured on the server, segmentation is refused with an
        explicit error rather than generating placeholder predictions.
      </div>

      {serviceError && (
        <div className="rounded-md bg-clay-soft p-3 text-xs text-clay">
          Could not communicate with the imaging service proxy: {serviceError}
        </div>
      )}

      {!loading && !serviceError && models.length > 0 && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-muted">
              Select Model
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={selectedModelId}
                onChange={(e) => {
                  setSelectedModelId(e.target.value);
                  setInferenceMessage(null);
                }}
                disabled={disabled || inferring}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.connected ? "(Ready)" : "(No weights loaded)"}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-muted">
              Target Structure
              <select
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={selectedClass}
                onChange={(e) => {
                  setSelectedClass(e.target.value);
                  setInferenceMessage(null);
                }}
                disabled={disabled || inferring}
              >
                <option value="3">Myoma (Uterine Fibroid)</option>
                <option value="1">Uterine Wall</option>
                <option value="2">Cavity</option>
                <option value="4">Nabothian Cyst</option>
                <option value="0">All Foreground Structures</option>
              </select>
            </label>
          </div>

          {selectedModel && (
            <div className="space-y-2 rounded-md border border-line/60 bg-paper/50 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">{selectedModel.name}</span>
                <span
                  className={`inline-flex items-center rounded-sm px-2 py-0.5 font-medium ${
                    selectedModel.connected ? "bg-pine-soft text-pine" : "bg-clay-soft text-clay"
                  }`}
                >
                  {selectedModel.connected ? "Connected" : "Not connected"}
                </span>
              </div>
              <p className="text-muted">{selectedModel.reason}</p>
              {selectedModel.intended_structures?.length > 0 && (
                <p className="text-muted">
                  <span className="font-medium text-ink">Intended structures:</span>{" "}
                  {selectedModel.intended_structures.join(", ")}
                </p>
              )}
              {selectedModel.licence_note && <p className="text-muted italic">{selectedModel.licence_note}</p>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              data-testid="run-ai-inference"
              onClick={() => void handleRunInference()}
              disabled={disabled || inferring || seriesFiles.length === 0 || !selectedModel?.connected}
              className="min-h-11 rounded-md bg-pine px-4 text-sm font-medium text-card disabled:opacity-50"
            >
              {inferring ? "Running inference…" : selectedModel?.connected ? "Run AI Model Segmentation" : "Weights Not Loaded (Inference Disabled)"}
            </button>
            {!selectedModel?.connected && (
              <span className="text-xs text-clay">
                Model weights not configured. Classical region growing remains available below.
              </span>
            )}
            {seriesFiles.length === 0 && selectedModel?.connected && (
              <span className="text-xs text-muted">Load a DICOM series to enable AI model inference.</span>
            )}
          </div>

          {inferenceMessage && (
            <div
              className={`rounded-md p-3 text-xs ${
                inferenceMessage.tone === "pine" ? "bg-pine-soft text-pine" : "bg-clay-soft text-clay"
              }`}
            >
              {inferenceMessage.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
