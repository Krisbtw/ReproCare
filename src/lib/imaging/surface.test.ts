import assert from "node:assert/strict";
import test from "node:test";
import { analyticEllipsoidMl, extractSurface, labelEllipsoid } from "./surface.ts";

test("voxel volume of a rasterized ellipsoid stays near the analytic volume", () => {
  const radii: [number, number, number] = [18, 15, 12];
  const grid = labelEllipsoid(36, 1.5, radii);
  const surface = extractSurface(grid, 36, 1.5);
  const analytic = analyticEllipsoidMl(radii);
  assert.equal(surface.componentCount, 1);
  assert.ok(surface.triangleCount > 100);
  assert.ok(surface.volumeMl > analytic * 0.8 && surface.volumeMl < analytic * 1.2);
});
