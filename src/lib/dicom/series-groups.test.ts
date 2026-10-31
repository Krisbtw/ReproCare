import assert from "node:assert/strict";
import test from "node:test";
import dicomParser from "dicom-parser";
import type { DataSetLike } from "./codec.ts";
import { buildSyntheticSeries } from "./series-writer.ts";
import { groupBySeries } from "./series-groups.ts";
import { loadSeries } from "./series-loader.ts";

const parse = (b: Uint8Array) => dicomParser.parseDicom(b) as unknown as DataSetLike;
const BASE = { cols: 24, rows: 24, slices: 10, pixelSpacingMm: [1, 1] as [number, number], sliceStepMm: 4, lesionRadiiMm: [6, 6, 12] as [number, number, number] };

test("a folder with two series is split into two groups, largest first, with descriptions", () => {
  const a = buildSyntheticSeries({ ...BASE, seriesUid: "1.2.3.1", description: "Sagittal T2" });
  const b = buildSyntheticSeries({ ...BASE, slices: 4, seriesUid: "1.2.3.2", description: "Localizer" });
  const mixed = [...b, ...a].reverse();
  const r = groupBySeries(mixed, parse);
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups[0].description, "Sagittal T2");
  assert.equal(r.groups[0].files.length, 10);
  assert.equal(r.groups[1].description, "Localizer");
  assert.equal(r.groups[1].files.length, 4);
  assert.equal(r.groups[0].modality, "MR");
  assert.equal(r.groups[0].rows, 24);
  assert.equal(r.groups[0].cols, 24);
});

test("each group loads into its own volume; the mixed pile alone is refused as mixed series", () => {
  const a = buildSyntheticSeries({ ...BASE, seriesUid: "1.2.3.1" });
  const b = buildSyntheticSeries({ ...BASE, slices: 6, seriesUid: "1.2.3.2" });
  const all = loadSeries([...a, ...b], parse);
  assert.equal(all.volume, null);
  assert.ok(all.report.issues.some((i) => i.code === "mixed_series"));
  const g = groupBySeries([...a, ...b], parse).groups;
  const first = loadSeries(g[0].files, parse);
  assert.equal(first.report.volumeReady, true);
  assert.equal(first.volume!.dims[2], 10);
});

test("unreadable files are listed with a reason and do not form a group; patient identifiers are not in the result", () => {
  const a = buildSyntheticSeries({ ...BASE, seriesUid: "1.2.3.1" });
  a.push({ name: "readme.txt", bytes: new TextEncoder().encode("hello ".repeat(50)) });
  const r = groupBySeries(a, parse);
  assert.equal(r.groups.length, 1);
  assert.equal(r.unreadable.length, 1);
  assert.equal(r.unreadable[0].name, "readme.txt");
  const text = JSON.stringify({ ...r, groups: r.groups.map((g) => ({ ...g, files: g.files.length })) });
  assert.equal(text.includes("SYNTHETIC^SERIES"), false);
  assert.equal(text.includes("SERIES-ONLY"), false);
});

test("noisy synthetic series is deterministic and keeps the lesion separable", () => {
  const spec = { ...BASE, noise: 12 };
  const one = buildSyntheticSeries(spec);
  const two = buildSyntheticSeries(spec);
  assert.deepEqual(one[3].bytes, two[3].bytes);
  const v = loadSeries(one, parse).volume!;
  const inside = v.data[12 + 24 * (12 + 24 * 5)];
  const outside = v.data[0];
  assert.ok(Math.abs(inside - 400) <= 13, `inside ${inside}`);
  assert.ok(Math.abs(outside - 100) <= 13, `outside ${outside}`);
  const noiseFree = loadSeries(buildSyntheticSeries(BASE), parse).volume!;
  assert.notDeepEqual(Array.from(v.data.slice(0, 50)), Array.from(noiseFree.data.slice(0, 50)));
});
