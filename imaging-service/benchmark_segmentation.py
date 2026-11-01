"""Benchmark script to measure inference latency and resource usage of segmentation models.
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np


def benchmark_inference(iterations: int = 5):
    """Measures inference latency and array throughput."""
    print(f"=== Running Segmentation Benchmark ({iterations} iterations) ===")
    from app import models

    statuses = models.statuses()
    print("Available model adapters:")
    for s in statuses:
        print(f" - {s.id} ({s.name}): connected={s.connected} ({s.reason})")

    # Generate synthetic 3D volume (e.g. 64x64x64) for pipeline timing
    vol = np.random.rand(64, 64, 64).astype(np.float32)
    spacing = (1.0, 1.0, 1.0)

    for adapter_id, adapter in models.ADAPTERS.items():
        st = adapter.status()
        if not st.connected:
            print(f"Skipping {adapter_id}: not connected ({st.reason})")
            continue

        latencies = []
        for i in range(iterations):
            t0 = time.time()
            try:
                _ = adapter.run(vol, spacing)
                latencies.append(time.time() - t0)
            except Exception as e:
                print(f"Error during run on {adapter_id}: {e}")
                break

        if latencies:
            print(f"✔ {adapter_id}: Avg latency {np.mean(latencies):.3f}s (P95: {np.percentile(latencies, 95):.3f}s)")


if __name__ == "__main__":
    benchmark_inference()

