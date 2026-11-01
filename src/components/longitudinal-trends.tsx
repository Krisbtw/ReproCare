import * as React from "react";
import { calculateGrowthRate, evaluateLongitudinalAlert, type ObservationPoint } from "@/lib/reprotrace/trends";

export interface FindingHistoryPoint {
  id: string;
  date: string;
  label: string;
  volumeMm3: number;
  longestMm?: number | null;
  modality: string;
}

export interface DiscrepancyItem {
  id: string;
  category: string;
  summary: string;
  detail: string;
}

export interface LongitudinalTrendsProps {
  patientName: string;
  history: FindingHistoryPoint[];
  discrepancies?: DiscrepancyItem[];
}

export function LongitudinalTrends({
  patientName,
  history,
  discrepancies = [],
}: LongitudinalTrendsProps) {
  const sorted = React.useMemo(
    () => [...history].sort((a, b) => a.date.localeCompare(b.date)),
    [history],
  );

  const observationPoints: ObservationPoint[] = React.useMemo(
    () => sorted.map((h) => ({ date: h.date, volumeMm3: h.volumeMm3 })),
    [sorted],
  );

  const growthRate = React.useMemo(
    () => calculateGrowthRate(observationPoints),
    [observationPoints],
  );

  const alert = React.useMemo(
    () => evaluateLongitudinalAlert(observationPoints),
    [observationPoints],
  );

  const maxVolume = React.useMemo(
    () => Math.max(...sorted.map((h) => h.volumeMm3), 100),
    [sorted],
  );

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/50 pb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Longitudinal Trajectory & Anatomical Memory
          </h2>
          <p className="text-sm text-muted-foreground">
            Volume progression, multi-exam growth rates, and discrepancy surveillance for {patientName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            Growth Rate: {growthRate > 0 ? `+${growthRate}` : `${growthRate}`} mm³/month
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Volumetric Trend Visualization */}
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
            Lesion Volume Progression
          </h3>
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No historical longitudinal examinations recorded.
            </p>
          ) : (
            <div className="space-y-3">
              {sorted.map((pt, i) => {
                const pct = Math.min(100, Math.max(8, (pt.volumeMm3 / maxVolume) * 100));
                return (
                  <div key={pt.id || i} className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{pt.date} ({pt.modality}) — {pt.label}</span>
                      <span className="font-mono text-foreground font-medium">
                        {(pt.volumeMm3 / 1000).toFixed(1)} cm³ ({pt.volumeMm3.toFixed(0)} mm³)
                      </span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Clinical Alerts & Active Surveillance */}
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-4">
          <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
            Clinical Surveillance Alerts
          </h3>
          {alert ? (
            <div
              className={`rounded-lg p-4 text-sm border ${
                alert.type === "rapid_growth"
                  ? "bg-destructive/10 border-destructive/30 text-destructive"
                  : alert.type === "significant_reduction"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted border-border text-muted-foreground"
              }`}
            >
              <div className="font-semibold capitalize mb-1">
                {alert.type.replace("_", " ")}
              </div>
              <p>{alert.message}</p>
            </div>
          ) : (
            <div className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
              Awaiting second longitudinal scan to establish trajectory.
            </div>
          )}

          {/* Active Discrepancies */}
          <div className="pt-2">
            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
              Cross-Examination Discrepancies ({discrepancies.length})
            </h4>
            {discrepancies.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No active geometric or reporting discrepancies detected.
              </p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {discrepancies.map((d) => (
                  <div key={d.id} className="rounded border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-900 dark:text-amber-200">
                    <div className="font-medium">{d.summary}</div>
                    <p className="text-[11px] opacity-80 mt-0.5">{d.detail}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
