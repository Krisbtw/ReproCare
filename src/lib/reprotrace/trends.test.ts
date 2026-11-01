import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateGrowthRate,
  calculateTrend,
  evaluateLongitudinalAlert,
  type ObservationPoint,
} from "./trends.ts";

describe("Longitudinal Trends & Growth Rates", () => {
  it("returns 0.0 when fewer than 2 points provided", () => {
    assert.equal(calculateGrowthRate([]), 0.0);
    assert.equal(calculateGrowthRate([{ date: "2025-01-01", volumeMm3: 100 }]), 0.0);
  });

  it("calculates positive growth rate correctly across months", () => {
    const points: ObservationPoint[] = [
      { date: "2025-01-01", volumeMm3: 1000 },
      { date: "2025-03-01", volumeMm3: 2000 },
      { date: "2025-05-01", volumeMm3: 3000 },
    ];
    const rate = calculateGrowthRate(points);
    assert.ok(rate > 450 && rate < 550, `Expected ~500 mm3/mo, got ${rate}`);
  });

  it("calculates trend trajectory (+1, -1, 0)", () => {
    assert.equal(calculateTrend([100, 150]), 1);
    assert.equal(calculateTrend([150, 100]), -1);
    assert.equal(calculateTrend([100, 102]), 0);
  });

  it("evaluates rapid growth alerts when rate > 500 mm3/mo", () => {
    const points: ObservationPoint[] = [
      { date: "2025-01-01", volumeMm3: 1000 },
      { date: "2025-02-01", volumeMm3: 2500 },
    ];
    const alert = evaluateLongitudinalAlert(points);
    assert.ok(alert);
    assert.equal(alert?.type, "rapid_growth");
    assert.ok(alert?.message.includes("Accelerated lesion expansion"));
  });
});
