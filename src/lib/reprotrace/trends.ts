/**
 * Longitudinal trends, volumetric growth rates, and alert detection for reproductive imaging.
 */

import { REPROTRACE_PARAMS } from "./params.ts";

export interface ObservationPoint {
  date: string;
  volumeMm3: number;
}

export interface LongitudinalAlert {
  type: "rapid_growth" | "significant_reduction" | "stable";
  message: string;
  growthRateMm3PerMonth: number;
}

/**
 * Calculates linear growth rate (mm³/month) from longitudinal observations.
 */
export function calculateGrowthRate(points: ObservationPoint[]): number {
  if (points.length < 2) return 0.0;

  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const t0 = new Date(sorted[0].date).getTime();
  const MS_PER_MONTH = 30.44 * 24 * 3600 * 1000;

  const x = sorted.map((p) => (new Date(p.date).getTime() - t0) / MS_PER_MONTH);
  const y = sorted.map((p) => p.volumeMm3);

  // Check if span is at least a few days
  if (x[x.length - 1] - x[0] < 0.05) return 0.0;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumXX = x.reduce((acc, xi) => acc + xi * xi, 0);

  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-6) return 0.0;

  const slope = (n * sumXY - sumX * sumY) / denom;
  return Number(slope.toFixed(2));
}

/**
 * Trajectory direction: +1 (growth), -1 (reduction), 0 (stable within ±5%).
 */
export function calculateTrend(values: number[]): -1 | 0 | 1 {
  if (values.length < 2) return 0;
  const first = values[0];
  const last = values[values.length - 1];
  if (last > first * 1.05) return 1;
  if (last < first * 0.95) return -1;
  return 0;
}

/**
 * Evaluates whether longitudinal trajectory requires clinician notification.
 */
export function evaluateLongitudinalAlert(points: ObservationPoint[]): LongitudinalAlert | null {
  if (points.length < 2) return null;
  const growthRate = calculateGrowthRate(points);

  // If growing > alert threshold (unvalidated research threshold for clinical review)
  if (growthRate > REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH) {
    return {
      type: "rapid_growth",
      message: `Accelerated lesion expansion detected: +${growthRate} mm³/month (unvalidated threshold >${REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH} mm³/mo). Recommend expedited clinician review.`,
      growthRateMm3PerMonth: growthRate,
    };
  } else if (growthRate < -REPROTRACE_PARAMS.RAPID_GROWTH_ALERT_MM3_PER_MONTH) {
    return {
      type: "significant_reduction",
      message: `Significant volume reduction noted: ${growthRate} mm³/month. Correlate with hormonal therapy or embolization response.`,
      growthRateMm3PerMonth: growthRate,
    };
  }

  return {
    type: "stable",
    message: `Lesion dimensions stable (${growthRate} mm³/month). Continue standard surveillance.`,
    growthRateMm3PerMonth: growthRate,
  };
}

