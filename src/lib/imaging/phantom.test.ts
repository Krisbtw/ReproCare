import assert from "node:assert/strict";
import test from "node:test";
import { drawSchematicSlice, markVisible, type SliceMark } from "./phantom.ts";

const mark: SliceMark = {
  id: "f",
  slice: 16,
  centroidMm: [2, 8, 18],
  radiiMm: [42, 38, 36],
  selected: true,
};

test("a finding is drawn on its stored slice and not many slices away", () => {
  assert.equal(markVisible(mark, 16), true);
  assert.equal(markVisible(mark, 0), false);
  const near = drawSchematicSlice(80, 100, 16, [mark]);
  const far = drawSchematicSlice(80, 100, 0, [mark]);
  let diff = 0;
  for (let i = 0; i < near.length; i += 1) if (near[i] !== far[i]) diff += 1;
  assert.ok(diff > 40);
});
