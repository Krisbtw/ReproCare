import { useEffect, useRef } from "react";
import { drawSchematicSlice, type SliceMark } from "@/lib/imaging/phantom";

type Props = {
  slice: number;
  sliceCount: number;
  marks: SliceMark[];
  onSlice: (slice: number) => void;
  plane: string;
};

export function SliceBoard({ slice, sliceCount, marks, onSlice, plane }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const max = Math.max(1, sliceCount - 1);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const pixels = drawSchematicSlice(canvas.width, canvas.height, slice, marks);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), canvas.width, canvas.height), 0, 0);
  }, [slice, marks]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg">Source slice</h2>
        <p className="text-xs tabular-nums text-muted">
          {plane || "plane not stored"} · {slice + 1} / {sliceCount}
        </p>
      </div>
      <canvas ref={ref} width={280} height={340} className="h-80 w-full rounded-md border border-line bg-paper object-contain" />
      <label className="block text-xs text-muted">
        Slice index
        <input
          className="mt-1 w-full"
          type="range"
          min={0}
          max={max}
          value={Math.min(slice, max)}
          onChange={(event) => onSlice(Number(event.target.value))}
        />
      </label>
      <p className="text-xs text-muted">
        Schematic stack built from stored centroids and slice indexes. It is not a reconstructed MRI and not a model prediction. The crosshair is the selected finding.
      </p>
    </div>
  );
}
