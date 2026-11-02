"""Synthetic imaging benchmarks for ReproCare / AnatomyBridge.
Measures DICOM parsing, volume assembly, 3D volume preprocessing,
surface mesh generation, memory usage, and Supabase retrieval latency.
"""
import io
import os
import sys
import time
import tracemalloc
import urllib.request
import numpy as np

# Ensure app package is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tests.conftest import make_series
from app import series, models
from app.unet import NumpySimpleUnet3D

def run_benchmarks():
    print("=" * 60)
    print("REPROCARE SYNTHETIC IMAGING BENCHMARKS")
    print("=" * 60)

    tracemalloc.start()
    results = {}

    # 1. Generate synthetic DICOM series (24 slices, 128x128)
    n_slices = 24
    rows, cols = 128, 128
    print(f"\n[1] Generating synthetic DICOM series ({n_slices} slices, {rows}x{cols})...")
    t0 = time.perf_counter()
    dicom_blobs = make_series(n=n_slices, rows=rows, cols=cols, px=(1.5, 1.5), step=3.0)
    gen_time_ms = (time.perf_counter() - t0) * 1000
    study_bytes = sum(len(b) for b in dicom_blobs)
    print(f"    Generated {n_slices} DICOM slices ({study_bytes / (1024*1024):.2f} MB total) in {gen_time_ms:.2f} ms")

    # 2. DICOM Parsing time
    print("\n[2] Benchmarking DICOM parsing and header extraction...")
    t0 = time.perf_counter()
    report, parsed_slices = series.inspect(dicom_blobs)
    t_parse_ms = (time.perf_counter() - t0) * 1000
    print(f"    DICOM inspection & parsing: {t_parse_ms:.2f} ms ({t_parse_ms / n_slices:.3f} ms/slice)")
    print(f"    Volume ready: {report.volume_ready}, Slices: {report.slice_count}")
    print(f"    Spacing: {report.pixel_spacing_mm}, Frame UID: {report.frame_of_reference_uid}")
    results["dicom_parsing_ms"] = t_parse_ms

    # 3. Multi-slice volume assembly & geometry verification
    print("\n[3] Benchmarking multi-slice volume assembly & geometry validation...")
    t0 = time.perf_counter()
    vol, geometry, stack_report = series.stack_volume_with_geometry(dicom_blobs)
    t_stack_ms = (time.perf_counter() - t0) * 1000
    print(f"    Volume assembly time: {t_stack_ms:.2f} ms")
    print(f"    Assembled volume shape (Z,Y,X): {vol.shape}, dtype: {vol.dtype}")
    print(f"    Physical spacing (Z,Y,X mm): {geometry.spacing_zyx_mm}")
    print(f"    Origin LPS (mm): {geometry.origin_lps_mm}")
    results["volume_assembly_ms"] = t_stack_ms

    # 4. 3D Volume Preprocessing (percentile clip + z-score)
    print("\n[4] Benchmarking 3D volume preprocessing...")
    t0 = time.perf_counter()
    normed_vol, prep_info = models.preprocess_mri_volume(vol)
    t_prep_ms = (time.perf_counter() - t0) * 1000
    print(f"    Preprocessing time: {t_prep_ms:.2f} ms")
    print(f"    Method: {prep_info['method']}, mean: {prep_info['mean']}, std: {prep_info['std']}")
    results["preprocessing_ms"] = t_prep_ms

    # 5. Pure-NumPy 3D U-Net Inference (Sub-volume patch or small volume)
    print("\n[5] Benchmarking pure-NumPy 3D U-Net inference...")
    model_np = NumpySimpleUnet3D(in_channels=1, out_channels=5, base_channels=8)
    sub_vol = normed_vol[:8, :32, :32][None, None, ...].astype(np.float32)
    t0 = time.perf_counter()
    logits = model_np.forward(sub_vol)
    pred_mask = np.argmax(logits, axis=1)[0].astype(np.uint8)
    t_infer_ms = (time.perf_counter() - t0) * 1000
    print(f"    NumPy 3D U-Net forward pass (shape {sub_vol.shape}): {t_infer_ms:.2f} ms")
    results["inference_ms"] = t_infer_ms

    # 6. Surface Mesh Generation (marching cubes / isosurface extraction)
    print("\n[6] Benchmarking 3D isosurface / mesh generation...")
    t0 = time.perf_counter()
    try:
        from skimage.measure import marching_cubes
        binary_mask = (vol > 150).astype(np.uint8)
        verts, faces, normals, values = marching_cubes(binary_mask, level=0.5, spacing=geometry.spacing_zyx_mm)
        t_mesh_ms = (time.perf_counter() - t0) * 1000
        print(f"    Marching cubes mesh generation: {t_mesh_ms:.2f} ms ({len(verts)} vertices, {len(faces)} triangles)")
        results["mesh_generation_ms"] = t_mesh_ms
    except ImportError:
        # SciPy fallback surface boundary extraction
        binary_mask = (vol > 150).astype(bool)
        eroded = ndimage_binary_erosion(binary_mask)
        surface_voxels = np.argwhere(binary_mask ^ eroded)
        t_mesh_ms = (time.perf_counter() - t0) * 1000
        print(f"    Surface boundary extraction: {t_mesh_ms:.2f} ms ({len(surface_voxels)} surface points)")
        results["mesh_generation_ms"] = t_mesh_ms

    # 7. Supabase Storage Retrieval Latency
    print("\n[7] Probing Supabase Storage retrieval latency...")
    supa_url = "https://mfbqdesghtvalkywzsdb.supabase.co"
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(f"{supa_url}/storage/v1/status", headers={"User-Agent": "ReproCare-Benchmark/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            code = resp.status
        t_supa_ms = (time.perf_counter() - t0) * 1000
        print(f"    Supabase Storage probe HTTP {code} latency: {t_supa_ms:.2f} ms")
        results["supabase_retrieval_ms"] = t_supa_ms
    except Exception as e:
        print(f"    Supabase Storage probe error: {e}")
        results["supabase_retrieval_ms"] = None

    # 8. Memory Usage
    current_mem, peak_mem = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    print("\n[8] Memory Profiling Results:")
    print(f"    Current memory: {current_mem / (1024*1024):.2f} MB")
    print(f"    Peak memory: {peak_mem / (1024*1024):.2f} MB")
    results["peak_memory_mb"] = peak_mem / (1024 * 1024)

    # 9. Large study scalability test (48 slices)
    print("\n[9] Testing maximum study scalability (48 slices, 128x128)...")
    large_blobs = make_series(n=48, rows=128, cols=128)
    t0 = time.perf_counter()
    large_vol, large_geom, large_rep = series.stack_volume_with_geometry(large_blobs)
    t_large_ms = (time.perf_counter() - t0) * 1000
    print(f"    48-slice study assembly: {t_large_ms:.2f} ms, shape {large_vol.shape}, {large_rep.slice_count} slices")
    results["large_study_slices"] = 48
    results["large_study_assembly_ms"] = t_large_ms

    print("\n" + "=" * 60)
    print("BENCHMARK SUMMARY")
    print("=" * 60)
    print(f"DICOM parsing time:       {results.get('dicom_parsing_ms', 0):.2f} ms ({n_slices} slices)")
    print(f"Volume assembly time:     {results.get('volume_assembly_ms', 0):.2f} ms")
    print(f"3D preprocessing time:    {results.get('preprocessing_ms', 0):.2f} ms")
    print(f"Inference time (patch):   {results.get('inference_ms', 0):.2f} ms")
    print(f"Mesh generation time:     {results.get('mesh_generation_ms', 0):.2f} ms")
    print(f"Supabase retrieval ping:  {results.get('supabase_retrieval_ms'):.2f} ms" if results.get('supabase_retrieval_ms') else "Supabase retrieval ping:  N/A")
    print(f"Peak memory:              {results.get('peak_memory_mb', 0):.2f} MB")
    print(f"Max tested study size:    48 slices (128x128x48 voxels, {len(large_blobs)} DICOM objects)")
    print("=" * 60)

    return results

def ndimage_binary_erosion(arr):
    from scipy import ndimage
    return ndimage.binary_erosion(arr)

if __name__ == "__main__":
    run_benchmarks()
