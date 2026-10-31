import assert from "node:assert/strict";
import test from "node:test";
import { extractReportSpans } from "./spans.ts";

test("report spans keep offsets and do not invent numbers", () => {
  const body =
    "Synthetic report. Anterior intramural fibroid, described as FIGO 4, about 4.2 cm. A posterior subserosal fibroid is described as 3.4 cm.";
  const spans = extractReportSpans(body);
  assert.deepEqual(
    spans.map((s) => s.text),
    ["FIGO 4", "4.2 cm", "3.4 cm"],
  );
  assert.equal(spans[0].kind, "figo");
  assert.equal(spans[1].kind, "measurement");
  assert.equal(body.slice(spans[1].start, spans[1].end), "4.2 cm");
  assert.equal(extractReportSpans("No sizes here.").length, 0);
});
