import { test } from "node:test";
import assert from "node:assert/strict";
import { pcosContext, ADOLESCENT_APP_THRESHOLD_YEARS } from "./pcos-context.ts";

test("under threshold is flagged possible adolescent", () => {
  const c = pcosContext(2010, 2026);
  assert.equal(c.level, "adolescent-possible");
  assert.equal(c.approxAge, 16);
  assert.ok(c.lines.some((l) => /both/.test(l) && /ultrasound/.test(l)));
});

test("threshold age itself is adult-default, one year under is flagged", () => {
  assert.equal(pcosContext(2026 - ADOLESCENT_APP_THRESHOLD_YEARS, 2026).level, "adult-default");
  assert.equal(pcosContext(2026 - ADOLESCENT_APP_THRESHOLD_YEARS + 1, 2026).level, "adolescent-possible");
});

test("missing or impossible year of birth is age-unknown, never adult", () => {
  for (const y of [null, undefined, Number.NaN, 2100, 1800]) {
    const c = pcosContext(y as number | null, 2026);
    assert.equal(c.level, "age-unknown");
    assert.equal(c.approxAge, null);
  }
});

test("ultrasound is never offered as support in any level", () => {
  for (const y of [2012, 1997, null]) assert.equal(pcosContext(y, 2026).withholdUltrasoundAsSupport, true);
});

test("copy states the threshold is the app's own, not the guideline's", () => {
  const c = pcosContext(2010, 2026);
  assert.ok(c.lines.join(" ").includes("this app's own"));
});

test("seeded Kavya (1997) is adult-default", () => {
  assert.equal(pcosContext(1997, 2026).level, "adult-default");
});
