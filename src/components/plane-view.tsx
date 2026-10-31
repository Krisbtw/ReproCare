import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractMaskSlice,
  extractSlice,
  pixelToVoxel,
  renderSlice,
  voxelToPixel,
  voxelValue,
  type Axis,
  type DisplayWindow,
} from "@/lib/imaging/lab";
import type { Mask, Vec3, Volume } from "@/lib/imaging/volume";

type Props = {
  volume: Volume;
  mask: Mask | null;
  axis: Axis;
  cursor: Vec3;
  seed: Vec3 | null;
  win: DisplayWindow;
  showMask: boolean;
  maskAlpha: number;
  onPick: (voxel: Vec3) => void;
  /** +1 / −1 / ±5: move along the slice axis. */
  onStep: (delta: number) => void;
};

const NICE_MM = [1, 2, 5, 10, 20, 50, 100, 200];
const OVERLAY = { r: 154, g: 70, b: 52 };

export function PlaneView({ volume, mask, axis, cursor, seed, win, showMask, maskAlpha, onPick, onStep }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ voxel: Vec3; value: number | null } | null>(null);
  const index = cursor[axis];

  const slice = useMemo(() => extractSlice(volume, axis, index), [volume, axis, index]);
  const maskSlice = useMemo(() => (mask && showMask ? extractMaskSlice(mask, axis, index) : null), [mask, showMask, axis, index]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const rgba = renderSlice(slice, win, maskSlice, { ...OVERLAY, alpha: maskAlpha });
    ctx.putImageData(new ImageData(rgba, slice.width, slice.height), 0, 0);
  }, [slice, win, maskSlice, maskAlpha]);

  // Wheel needs a non-passive listener so the page does not scroll while a slice is being scrubbed.
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      stepRef.current(event.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const widthMm = slice.width * slice.mmPerPx[0];
  const heightMm = slice.height * slice.mmPerPx[1];
  const aspect = widthMm / heightMm;
  const barMm = [...NICE_MM].reverse().find((n) => n <= widthMm * 0.25) ?? NICE_MM[0];

  function locate(event: { clientX: number; clientY: number }): Vec3 | null {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const col = Math.min(slice.width - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * slice.width)));
    const row = Math.min(slice.height - 1, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * slice.height)));
    return pixelToVoxel(volume.dims, axis, index, col, row);
  }

  const seedPx = seed ? voxelToPixel(volume.dims, axis, seed) : null;
  const seedOnThisSlice = seed ? seed[axis] === index : false;

  return (
    <div className="space-y-2">
      <div
        ref={frameRef}
        tabIndex={0}
        role="group"
        aria-label="Image slice. Click to place the seed. Arrow keys or the mouse wheel change slice."
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowRight") onStep(1);
          else if (event.key === "ArrowDown" || event.key === "ArrowLeft") onStep(-1);
          else if (event.key === "PageUp") onStep(5);
          else if (event.key === "PageDown") onStep(-5);
          else return;
          event.preventDefault();
        }}
        className="relative mx-auto w-full overflow-hidden rounded-md border border-line bg-ink"
        style={{ maxWidth: `calc(66vh * ${aspect})`, aspectRatio: `${aspect}` }}
      >
        <canvas
          ref={canvasRef}
          width={slice.width}
          height={slice.height}
          data-testid="plane-canvas"
          className="absolute inset-0 h-full w-full cursor-crosshair"
          style={{ imageRendering: "pixelated" }}
          onClick={(event) => {
            const v = locate(event);
            if (v) onPick(v);
          }}
          onPointerMove={(event) => {
            const v = locate(event);
            setHover(v ? { voxel: v, value: voxelValue(volume, v) } : null);
          }}
          onPointerLeave={() => setHover(null)}
        />
        {seedPx && (
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox={`0 0 ${slice.width} ${slice.height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {seedOnThisSlice ? (
              <g stroke="#f3efe6" strokeWidth={1.5} vectorEffect="non-scaling-stroke">
                <line x1={seedPx.col + 0.5} x2={seedPx.col + 0.5} y1={0} y2={Math.max(0, seedPx.row - 3)} vectorEffect="non-scaling-stroke" />
                <line x1={seedPx.col + 0.5} x2={seedPx.col + 0.5} y1={Math.min(slice.height, seedPx.row + 4)} y2={slice.height} vectorEffect="non-scaling-stroke" />
                <line y1={seedPx.row + 0.5} y2={seedPx.row + 0.5} x1={0} x2={Math.max(0, seedPx.col - 3)} vectorEffect="non-scaling-stroke" />
                <line y1={seedPx.row + 0.5} y2={seedPx.row + 0.5} x1={Math.min(slice.width, seedPx.col + 4)} x2={slice.width} vectorEffect="non-scaling-stroke" />
              </g>
            ) : (
              <circle cx={seedPx.col + 0.5} cy={seedPx.row + 0.5} r={2.5} fill="none" stroke="#f3efe6" strokeOpacity={0.55} strokeWidth={1.5} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        )}
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col items-start gap-1 text-[11px] text-paper">
          <div className="h-1 rounded-sm bg-paper" style={{ width: `${(barMm / widthMm) * 100 * 1}%`, minWidth: 6 }} />
          <span className="rounded-sm bg-ink/70 px-1 tabular-nums">{barMm} mm</span>
        </div>
      </div>
      <p className="min-h-5 text-xs tabular-nums text-muted" aria-live="off">
        {hover
          ? `x ${hover.voxel[0]} · y ${hover.voxel[1]} · slice ${hover.voxel[2]} · intensity ${hover.value == null ? "n/a" : hover.value.toFixed(1)}`
          : "Hover to read a voxel. Click to place the seed."}
      </p>
    </div>
  );
}
