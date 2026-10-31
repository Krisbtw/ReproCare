import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pcosContext,
  ADOLESCENT_APP_THRESHOLD_YEARS,
  checkMenarcheYear,
  cycleBand,
  gynaecologicalAge,
  outsideBand,
} from "./pcos-context.ts";

/* ---- original six tests (year-of-birth rule), unchanged in intent ---- */

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
  for (const m of [2024, 2018, 2010]) assert.equal(pcosContext(2005, 2026, m).withholdUltrasoundAsSupport, true);
});

test("copy states the threshold is the app's own, not the guideline's", () => {
  const c = pcosContext(2010, 2026);
  assert.ok(c.lines.join(" ").includes("this app's own"));
});

test("seeded Kavya (1997) is adult-default", () => {
  assert.equal(pcosContext(1997, 2026).level, "adult-default");
});

/* ---- first-period (menarche) rule ---- */

test("menarche year replaces the birth-year rule when stored", () => {
  const c = pcosContext(2008, 2026, 2020);
  assert.equal(c.basis, "menarche");
  assert.equal(c.level, "menarche-under-8");
  assert.deepEqual(c.gynAge, { years: 6, min: 5, max: 7 });
  assert.ok(c.lines.join(" ").includes("8 years"));
});

test("year-only precision: 7 and 8 stored years sit on the boundary, 9 is clear", () => {
  // years=7 -> true elapsed in (6, 8): max is 8, never exceeds it -> under-8
  assert.equal(pcosContext(2000, 2026, 2019).level, "menarche-under-8");
  // years=8 -> (7, 9): straddles 8 -> boundary, never decided
  assert.equal(pcosContext(2000, 2026, 2018).level, "menarche-boundary-8");
  // years=9 -> (8, 10): min is 8 -> 8-plus
  assert.equal(pcosContext(2000, 2026, 2017).level, "menarche-8-plus");
});

test("an adult by birth year can still be under 8 years since menarche", () => {
  // Born 2003 (age 23 > app threshold), menarche 2021 (age 18): still within 8 years
  const c = pcosContext(2003, 2026, 2021);
  assert.equal(c.level, "menarche-under-8");
  assert.equal(c.approxAge, 23);
});

test("implausible menarche is rejected, said so, and the birth-year rule is used", () => {
  const c = pcosContext(2000, 2026, 2003); // age 3 at menarche
  assert.equal(c.basis, "birth-year");
  assert.ok(c.menarcheProblem && /age 3/.test(c.menarcheProblem));
  assert.ok(c.lines[0].startsWith("A stored first-period year was not used"));
});

test("checkMenarcheYear refuses future, non-integer and out-of-range ages; accepts plausible", () => {
  assert.equal(checkMenarcheYear(2030, 2000, 2026).ok, false);
  assert.equal(checkMenarcheYear(2012.5, 2000, 2026).ok, false);
  assert.equal(checkMenarcheYear(null, 2000, 2026).ok, false);
  assert.equal(checkMenarcheYear(2030 - 30, 2000, 2026).ok, false); // age 0
  assert.equal(checkMenarcheYear(2030, null, 2026).ok, false);
  const ok = checkMenarcheYear(2012, 2000, 2026);
  assert.ok(ok.ok && ok.year === 2012);
  // no birth year: only range checks apply
  assert.equal(checkMenarcheYear(2012, null, 2026).ok, true);
});

/* ---- cycle band ---- */

test("cycle band follows years since menarche and refuses edges", () => {
  assert.equal(cycleBand(null).status, "unknown");
  assert.equal(cycleBand(gynaecologicalAge(2026, 2026)).status, "transition"); // 0 -> (0,1)
  assert.equal(cycleBand(gynaecologicalAge(2025, 2026)).status, "boundary"); // 1 -> (0,2) straddles 1
  assert.equal(cycleBand(gynaecologicalAge(2024, 2026)).status, "band"); // 2 -> (1,3): touches edges, does not cross them
  assert.equal(cycleBand(gynaecologicalAge(2023, 2026)).status, "boundary"); // 3 -> (2,4) straddles 3
  assert.equal(cycleBand(gynaecologicalAge(2022, 2026)).status, "band"); // 4 -> (3,5)
});

test("cycle band values", () => {
  const b2 = cycleBand({ years: 2, min: 1, max: 3 });
  assert.equal(b2.status, "band");
  if (b2.status === "band") assert.deepEqual([b2.lowDays, b2.highDays], [21, 45]);
  const b10 = cycleBand(gynaecologicalAge(2016, 2026));
  assert.equal(b10.status, "band");
  if (b10.status === "band") {
    assert.deepEqual([b10.lowDays, b10.highDays, b10.minCyclesPerYear], [21, 35, 8]);
    assert.equal(outsideBand(32, b10), false);
    assert.equal(outsideBand(38, b10), true);
    assert.equal(outsideBand(19, b10), true);
    assert.equal(outsideBand(null, b10), null);
  }
  assert.equal(outsideBand(40, cycleBand(null)), null);
});
