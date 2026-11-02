import { useEffect, useState } from "react";
import { proxyListModels, proxySegment, type ProxyModelStatus } from "@/routes/api/-imaging-proxy";
import {
  extractClassMaskFromVolume,
  parseSegmentationResponse,
  validateSegmentationGeometryAlignment,
  type ParsedSegmentationResponse,
  type SourceScanGeometry,
} from "@/lib/imaging/service-client";
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

export type InferenceProgressStage =
  | "idle"
  | "checking_model"
  | "preparing_slices"
  | "running_inference"
  | "validating_geometry"
  | "completed"
  | "error";

const STAGE_LABELS: Record<InferenceProgressStage, string> = {
  idle: "",
  checking_model: "Step 1/4: Checking model readiness & checkpoint integrity…",
  preparing_slices: "Step 2/4: Preparing de-identified DICOM slices for proxy upload…",
  running_inference: "Step 3/4: Running 3D U-Net volumetric segmentation inference…",
  validating_geometry: "Step 4/4: Validating 3D scan geometry, spacing, and coordinate alignment…",
  completed: "AI inference completed and geometry alignment verified.",
  error: "AI inference stopped.",
};

export type AiSegmentSuccess = {
  labels: Record<string, string>;
  mask: Mask;
  model: {
    id: string;
    name: string;
    is_learned_model: boolean;
    architecture?: string;
    modelVersion?: string | null;
    datasetVersion?: string | null;
    checkpointSha256?: string | null;
    trainingMode?: string | null;
    isClinicalGrade?: boolean;
    weights?: string;
    command?: string;
  };
  note: string;
  voxelCount: number;
  structureName: string;
  classVoxelCounts?: Record<string, number>;
  geometryVerified: boolean;
};

export function ModelStatusPanel({
  seriesFiles = [],
  sourceGeometry = null,
  disabled = false,
  showOverlay = true,
  onToggleOverlay,
  onSegmentSuccess,
}: {
  seriesFiles?: { name: string; bytes: Uint8Array }[];
  sourceGeometry?: SourceScanGeometry | null;
  disabled?: boolean;
  showOverlay?: boolean;
  onToggleOverlay?: (show: boolean) => void;
  onSegmentSuccess?: (result: AiSegmentSuccess) => void;
}) {
  const [models, setModels] = useState<ProxyModelStatus[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedClass, setSelectedClass] = useState<string>("3"); // 3 = myoma (uterine fibroid)
  const [loading, setLoading] = useState<boolean>(true);
  const [inferring, setInferring] = useState<boolean>(false);
  const [progressStage, setProgressStage] = useState<InferenceProgressStage>("idle");
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [inferenceMessage, setInferenceMessage] = useState<{ tone: "clay" | "pine"; text: string } | null>(null);
  const [cachedPrediction, setCachedPrediction] = useState<{
    parsed: ParsedSegmentationResponse;
    decompressed: Uint8Array;
  } | null>(null);

  useEffect(() => {
    let active = true;
    async function fetchModels() {
      setLoading(true);
      setServiceError(null);
      try {
        const list = (await proxyListModels()) as ProxyModelStatus[];
        if (active) {
          setModels(list);
          if (list.length > 0 && !selectedModelId) {
            const firstConnected = list.find((m) => m.connected);
            setSelectedModelId((firstConnected ?? list[0]).id);
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

  // Reset cached prediction if the loaded DICOM series changes
  useEffect(() => {
    setCachedPrediction(null);
    setProgressStage("idle");
    setInferenceMessage(null);
  }, [seriesFiles]);

  function emitClassOverlay(
    parsed: ParsedSegmentationResponse,
    decompressed: Uint8Array,
    targetClassStr: string,
  ) {
    const targetVal = Number(targetClassStr);
    const { mask, voxelCount, classVoxelCounts } = extractClassMaskFromVolume(
      decompressed,
      parsed.shapeZyx,
      parsed.spacingZyxMm,
      targetVal,
      parsed.labels,
    );

    const structureName =
      parsed.labels[targetClassStr] || (targetVal === 0 ? "All foreground structures" : `Class ${targetClassStr}`);

    setInferenceMessage({
      tone: "pine",
      text: `${parsed.note} (${voxelCount.toLocaleString()} voxels segmented for ${structureName}; 3D scan geometry verified)`,
    });

    if (onSegmentSuccess) {
      onSegmentSuccess({
        labels: parsed.labels,
        mask,
        model: {
          id: parsed.modelId,
          name: parsed.modelName,
          is_learned_model: parsed.isLearnedModel,
          architecture: parsed.architecture,
          modelVersion: parsed.modelVersion,
          datasetVersion: parsed.datasetVersion,
          checkpointSha256: parsed.checkpointSha256,
          trainingMode: parsed.trainingMode,
          isClinicalGrade: parsed.isClinicalGrade,
        },
        note: parsed.note,
        voxelCount,
        structureName,
        classVoxelCounts,
        geometryVerified: true,
      });
    }
  }

  async function handleRunInference() {
    if (!selectedModelId || seriesFiles.length === 0) return;
    setInferring(true);
    setProgressStage("checking_model");
    setInferenceMessage(null);

    try {
      const selectedModel = models.find((m) => m.id === selectedModelId);
      if (selectedModel && !selectedModel.connected) {
        throw new Error(selectedModel.reason || "Model weights are not connected on the server.");
      }

      setProgressStage("preparing_slices");
      const payloadFiles = seriesFiles.slice(0, 1000).map((f) => ({
        name: f.name,
        base64: uint8ToBase64(f.bytes),
      }));

      setProgressStage("running_inference");
      const rawResponse = await proxySegment({
        data: {
          modelId: selectedModelId,
          files: payloadFiles,
        },
      });

      setProgressStage("validating_geometry");
      const parsedJson = JSON.parse(rawResponse) as unknown;
      const parsed = parseSegmentationResponse(parsedJson);
      if (!parsed) {
        throw new Error("Model response was missing required volumetric mask or geometry fields.");
      }

      if (sourceGeometry) {
        const alignment = validateSegmentationGeometryAlignment(sourceGeometry, parsed);
        if (!alignment.aligned) {
          throw new Error(`Refusing misaligned AI segmentation mask: ${alignment.problems.join(" ")}`);
        }
      }

      const decompressed = await decompressZlibMask(parsed.maskB64Zlib);
      setCachedPrediction({ parsed, decompressed });
      emitClassOverlay(parsed, decompressed, selectedClass);
      setProgressStage("completed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setProgressStage("error");
      setCachedPrediction(null);
      setInferenceMessage({
        tone: "clay",
        text: `Inference refused: ${msg}`,
      });
    } finally {
      setInferring(false);
    }
  }

  function handleClassChange(nextClass: string) {
    setSelectedClass(nextClass);
    if (cachedPrediction) {
      try {
        emitClassOverlay(cachedPrediction.parsed, cachedPrediction.decompressed, nextClass);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setInferenceMessage({ tone: "clay", text: msg });
      }
    } else {
      setInferenceMessage(null);
    }
  }

  const selectedModel = models.find((m) => m.id === selectedModelId);

  return (
    <div className="space-y-4 rounded-md border border-line bg-card p-4 text-sm" data-testid="model-status-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-ink">AI Segmentation Models (Optional Service)</h3>
          <span className="inline-flex items-center rounded-sm bg-paper px-2 py-0.5 text-xs font-medium text-ink-soft">
            Experimental · Distinct from Seeded Region Growing
          </span>
        </div>
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
        masks. If trained model weights are missing or incompatible on the server, segmentation is refused with an
        explicit error rather than generating placeholder predictions. Manual seeded region-growing remains available
        above.
      </div>

      {serviceError && (
        <div className="rounded-md bg-clay-soft p-3 text-xs text-clay" data-testid="ai-service-error">
          Could not communicate with the imaging service proxy: {serviceError}
        </div>
      )}

      {!loading && !serviceError && models.length > 0 && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-muted">
              Select Model
              <select
                data-testid="ai-model-select"
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={selectedModelId}
                onChange={(e) => {
                  setSelectedModelId(e.target.value);
                  setCachedPrediction(null);
                  setProgressStage("idle");
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
                data-testid="ai-structure-select"
                className="mt-1 min-h-11 w-full rounded-md border border-line bg-paper px-2 text-sm text-ink"
                value={selectedClass}
                onChange={(e) => handleClassChange(e.target.value)}
                disabled={disabled || inferring}
              >
                <option value="3">Myoma (Uterine Fibroid · Label 3)</option>
                <option value="1">Uterine Wall (Myometrium · Label 1)</option>
                <option value="2">Uterine Cavity (Endometrium · Label 2)</option>
                <option value="4">Nabothian Cyst (Label 4)</option>
                <option value="0">All Foreground Structures (Labels 1–4)</option>
              </select>
            </label>
          </div>

          {selectedModel && (
            <div className="space-y-2 rounded-md border border-line/60 bg-paper/50 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
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
              {selectedModel.architecture && (
                <p className="text-muted">
                  <span className="font-medium text-ink">Architecture:</span> {selectedModel.architecture}
                </p>
              )}
              {(selectedModel.model_version || selectedModel.checkpoint_sha256) && (
                <p className="text-muted tabular-nums">
                  {selectedModel.model_version && (
                    <>
                      <span className="font-medium text-ink">Version:</span> {selectedModel.model_version}{" "}
                    </>
                  )}
                  {selectedModel.checkpoint_sha256 && (
                    <>
                      · <span className="font-medium text-ink">SHA-256:</span>{" "}
                      {selectedModel.checkpoint_sha256.slice(0, 12)}…
                    </>
                  )}
                </p>
              )}
              {selectedModel.intended_structures && selectedModel.intended_structures.length > 0 && (
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
              {inferring
                ? "Running inference…"
                : selectedModel?.connected
                  ? "Run AI Model Segmentation"
                  : "Weights Not Loaded (Inference Disabled)"}
            </button>

            {cachedPrediction && onToggleOverlay && (
              <button
                type="button"
                data-testid="toggle-ai-overlay"
                onClick={() => onToggleOverlay(!showOverlay)}
                className="min-h-11 rounded-md border border-line bg-paper px-3 text-xs font-medium text-ink"
              >
                {showOverlay ? "Hide AI Overlay on MRI" : "Show AI Overlay on MRI"}
              </button>
            )}

            {!selectedModel?.connected && (
              <span className="text-xs text-clay">
                Model weights not configured. Classical region growing remains available above.
              </span>
            )}
            {seriesFiles.length === 0 && selectedModel?.connected && (
              <span className="text-xs text-muted">Load a DICOM series to enable AI model inference.</span>
            )}
          </div>

          {inferring && STAGE_LABELS[progressStage] && (
            <div
              role="status"
              data-testid="ai-inference-progress"
              className="rounded-md border border-pine/30 bg-pine-soft/20 px-3 py-2 text-xs text-pine"
            >
              {STAGE_LABELS[progressStage]}
            </div>
          )}

          {inferenceMessage && (
            <div
              data-testid="ai-inference-message"
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
