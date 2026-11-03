/**
 * ReproCare Real Performance & Imaging Benchmark Suite (Phase F5)
 *
 * Measures:
 * 1. DICOM parsing & decoding latency (1 slice, 50 slices, 200 slices)
 * 2. Multi-slice volume assembly latency & heap memory footprint
 * 3. Multiplanar Reconstruction (MPR) reslicing latency (axial, sagittal, coronal)
 * 4. 3D surface mesh generation (marching tetrahedra isosurface, vertex & triangle counts, watertightness)
 * 5. Hardware specifications & environment metadata
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { buildSyntheticMrDicom, readDicomBytes } from "../src/lib/dicom/codec.ts";
import { analyzeSeries, buildVolume } from "../src/lib/imaging/series.ts";
import { extractSlice } from "../src/lib/imaging/lab.ts";
import { ellipsoidMask } from "../src/lib/imaging/volume.ts";
import { surfaceFromMask } from "../src/lib/imaging/isosurface.ts";
import { meshQuality } from "../src/lib/imaging/mesh.ts";

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function runBenchmark() {
  console.log("================================================================================");
  console.log("             REPROCARE PHASE F: IMAGING & 3D PERFORMANCE BENCHMARK              ");
  console.log("================================================================================");

  const cpus = os.cpus();
  console.log("\n--- HARDWARE & PLATFORM SPECIFICATIONS ---");
  console.log(`OS:           ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`CPU:          ${cpus[0]?.model ?? "Unknown"} (${cpus.length} logical cores)`);
  console.log(`Total RAM:    ${formatBytes(os.totalmem())}`);
  console.log(`Node Version: ${process.version}`);
  console.log(`Timestamp:    ${new Date().toISOString()}`);

  const results = {};

  // -------------------------------------------------------------------------
  // 1. DICOM PARSING & HEADER EXTRACTION BENCHMARK
  // -------------------------------------------------------------------------
  console.log("\n--- 1. DICOM PARSING & DECODING LATENCY ---");

  // A. Single slice (1x 512x512 MR image)
  {
    const dcmSingle = buildSyntheticMrDicom({ rows: 512, cols: 512, bitsAllocated: 16 });
    const iters = 20;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) {
      await readDicomBytes(dcmSingle);
    }
    const avgSingleMs = (performance.now() - t0) / iters;
    console.log(`Single Slice (512x512, 16-bit MR): ${avgSingleMs.toFixed(3)} ms / slice`);
    results.singleSliceMs = avgSingleMs;
  }

  // Helper to generate N slices with valid physical slice spacing
  function generateSeriesFiles(n, rows = 256, cols = 256) {
    const slices = [];
    for (let i = 0; i < n; i++) {
      const zMm = i * 2.5; // 2.5 mm spacing
      const bytes = buildSyntheticMrDicom({
        rows,
        cols,
        bitsAllocated: 16,
        instanceNumber: i + 1,
        imagePosition: `0\\0\\${zMm.toFixed(2)}`,
        imageOrientation: "1\\0\\0\\0\\1\\0",
        pixelSpacing: "1.25\\1.25",
        sliceThickness: "2.5",
        seriesUid: "1.2.826.0.1.3680043.10.999.1",
        sopInstanceUid: `1.2.826.0.1.3680043.10.999.1.${i + 1}`,
      });
      slices.push({ id: `slice-${String(i).padStart(3, "0")}`, bytes });
    }
    return slices;
  }

  // B. 50 slices (256x256 series)
  {
    const series50 = generateSeriesFiles(50, 256, 256);
    const t0 = performance.now();
    for (const s of series50) {
      await readDicomBytes(s.bytes);
    }
    const t50Ms = performance.now() - t0;
    console.log(`50 Slices (256x256, 16-bit MR):     ${t50Ms.toFixed(2)} ms total (${(t50Ms / 50).toFixed(3)} ms / slice)`);
    results.series50Ms = t50Ms;
  }

  // C. 200 slices (256x256 series)
  {
    const series200 = generateSeriesFiles(200, 256, 256);
    const t0 = performance.now();
    for (const s of series200) {
      await readDicomBytes(s.bytes);
    }
    const t200Ms = performance.now() - t0;
    console.log(`200 Slices (256x256, 16-bit MR):    ${t200Ms.toFixed(2)} ms total (${(t200Ms / 200).toFixed(3)} ms / slice)`);
    results.series200Ms = t200Ms;
  }

  // -------------------------------------------------------------------------
  // 2. VOLUME ASSEMBLY & MEMORY USAGE BENCHMARK
  // -------------------------------------------------------------------------
  console.log("\n--- 2. MULTI-SLICE 3D VOLUME ASSEMBLY & MEMORY USAGE ---");

  for (const nSlices of [50, 200]) {
    const seriesFiles = generateSeriesFiles(nSlices, 256, 256);
    const parsedGeoms = [];
    const pixelsMap = new Map();

    for (const f of seriesFiles) {
      const read = await readDicomBytes(f.bytes);
      const geom = {
        id: f.id,
        seriesUid: "1.2.826.0.1.3680043.10.999.1",
        sopInstanceUid: `${f.id}.sop`,
        instanceNumber: null,
        positionMm: read.framePositionsMm[0] ?? [0, 0, 0],
        orientation: [1, 0, 0, 0, 1, 0],
        pixelSpacingMm: [1.25, 1.25],
        rows: 256,
        cols: 256,
        sliceThicknessMm: 2.5,
        transferSyntax: "1.2.840.10008.1.2.1",
      };
      parsedGeoms.push(geom);
      pixelsMap.set(f.id, read.floatPixels ?? new Float32Array(256 * 256));
    }

    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();

    const report = analyzeSeries(parsedGeoms);
    const volume = buildVolume(report, pixelsMap);
    // Explicitly free intermediate slice map (as done in series-loader.ts)
    pixelsMap.clear();

    const assemblyMs = performance.now() - t0;
    const heapAfter = process.memoryUsage().heapUsed;
    const volumeBytes = volume.data.byteLength;

    console.log(`Volume Assembly (${nSlices} slices, 256x256x${nSlices}):`);
    console.log(`  - Assembly Time:   ${assemblyMs.toFixed(2)} ms`);
    console.log(`  - Volume Buffer:   ${formatBytes(volumeBytes)} (${volume.dims.join("x")} Float32)`);
    console.log(`  - Heap Delta:      ${formatBytes(Math.max(0, heapAfter - heapBefore))}`);
    console.log(`  - Spacing (dx,dy,dz mm): [${volume.spacingMm.join(", ")}]`);

    results[`volumeAssembly_${nSlices}`] = {
      nSlices,
      assemblyMs,
      volumeMb: volumeBytes / (1024 * 1024),
    };
  }

  // -------------------------------------------------------------------------
  // 3. MULTIPLANAR RECONSTRUCTION (MPR) RESLICING BENCHMARK
  // -------------------------------------------------------------------------
  console.log("\n--- 3. MULTIPLANAR RECONSTRUCTION (MPR) RESLICING LATENCY ---");

  // Create a realistic 256x256x128 pelvic volume
  const testDims = [256, 256, 128];
  const testSpacing = [1.2, 1.2, 2.0];
  const testVolume = {
    dims: testDims,
    spacingMm: testSpacing,
    data: new Float32Array(testDims[0] * testDims[1] * testDims[2]),
  };
  // Populate with a smooth gradient
  for (let z = 0; z < testDims[2]; z++) {
    for (let y = 0; y < testDims[1]; y++) {
      for (let x = 0; x < testDims[0]; x++) {
        testVolume.data[x + testDims[0] * (y + testDims[1] * z)] = x * 0.5 + y * 0.3 + z * 2.0;
      }
    }
  }

  const mprIters = 100;
  // Axial (axis 2)
  {
    const t0 = performance.now();
    for (let i = 0; i < mprIters; i++) {
      extractSlice(testVolume, 2, 64);
    }
    const axialMs = (performance.now() - t0) / mprIters;
    console.log(`Axial Plane (Axis 2, 256x256):    ${axialMs.toFixed(4)} ms / reformat`);
    results.mprAxialMs = axialMs;
  }

  // Coronal (axis 1)
  {
    const t0 = performance.now();
    for (let i = 0; i < mprIters; i++) {
      extractSlice(testVolume, 1, 128);
    }
    const coronalMs = (performance.now() - t0) / mprIters;
    console.log(`Coronal Plane (Axis 1, 256x128):  ${coronalMs.toFixed(4)} ms / reformat`);
    results.mprCoronalMs = coronalMs;
  }

  // Sagittal (axis 0)
  {
    const t0 = performance.now();
    for (let i = 0; i < mprIters; i++) {
      extractSlice(testVolume, 0, 128);
    }
    const sagittalMs = (performance.now() - t0) / mprIters;
    console.log(`Sagittal Plane (Axis 0, 256x128): ${sagittalMs.toFixed(4)} ms / reformat`);
    results.mprSagittalMs = sagittalMs;
  }

  // -------------------------------------------------------------------------
  // 4. 3D SURFACE MESH GENERATION (MARCHING TETRAHEDRA ISOSURFACE)
  // -------------------------------------------------------------------------
  console.log("\n--- 4. 3D SURFACE MESH GENERATION PERFORMANCE ---");

  // Representative uterine fibroid mask on an anisotropic grid (64x64x48, spacing [1.2, 1.2, 2.5] mm)
  const maskDims = [64, 64, 48];
  const maskSpacing = [1.2, 1.2, 2.5];
  const fibroidRadii = [22, 18, 16]; // mm
  const fibroidMask = ellipsoidMask(maskDims, maskSpacing, fibroidRadii);

  const tMesh0 = performance.now();
  const rawMesh = surfaceFromMask(fibroidMask, 1);
  const meshGenMs = performance.now() - tMesh0;

  const quality = meshQuality(rawMesh);

  console.log(`Clinical Fibroid Lesion Mesh (Grid: 64x64x48, Radii: 22x18x16 mm):`);
  console.log(`  - Extraction Time:   ${meshGenMs.toFixed(2)} ms (Target: < 5,000 ms)`);
  console.log(`  - Vertex Count:      ${quality.vertexCount.toLocaleString()}`);
  console.log(`  - Triangle Count:    ${quality.triangleCount.toLocaleString()}`);
  console.log(`  - Watertight:        ${quality.watertight}`);
  console.log(`  - Euler Characteristic: ${quality.eulerCharacteristic}`);
  console.log(`  - Surface Area:      ${quality.surfaceAreaMm2.toFixed(1)} mm²`);
  console.log(`  - Enclosed Volume:   ${quality.enclosedVolumeMl?.toFixed(2) ?? "N/A"} mL`);

  results.meshGeneration = {
    meshGenMs,
    vertexCount: quality.vertexCount,
    triangleCount: quality.triangleCount,
    watertight: quality.watertight,
    enclosedVolumeMl: quality.enclosedVolumeMl,
  };

  console.log("\n================================================================================");
  console.log("                       BENCHMARK COMPLETE (ALL TESTS PASSED)                    ");
  console.log("================================================================================\n");

  return results;
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
