"""Load testing script for ReproCare trends and segmentation APIs.
Simulates concurrent clinician requests to measure latency, throughput, and error rates.
"""
from __future__ import annotations

import argparse
import asyncio
import random
import time
from typing import Any, Dict, List

try:
    import aiohttp
    import numpy as np
except ImportError:
    aiohttp = None
    np = None


async def make_request(session: Any, patient_id: str, token: str, base_url: str) -> Dict[str, Any]:
    url = f"{base_url}/trends/calculate"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "observations": [
            {"date": "2025-01-01", "volume_mm3": 1000.0},
            {"date": "2025-03-01", "volume_mm3": 1500.0},
            {"date": "2025-05-01", "volume_mm3": 2100.0},
        ],
        "current_findings": [{"finding_id": "f1", "volume_mm3": 2100.0}],
        "historical_findings": [{"finding_id": "f1", "volume_mm3": 1000.0}],
    }

    t0 = time.time()
    try:
        async with session.post(url, headers=headers, json=payload, timeout=10) as response:
            latency = time.time() - t0
            if response.status == 200:
                data = await response.json()
                return {
                    "status": "success",
                    "latency": latency,
                    "growth_rate": data.get("growth_rate_mm3_per_month"),
                }
            else:
                return {
                    "status": "error",
                    "status_code": response.status,
                    "latency": latency,
                }
    except Exception as e:
        return {
            "status": "exception",
            "error": str(e),
            "latency": time.time() - t0,
        }


async def run_load_test(base_url: str, token: str, num_requests: int = 50, concurrency: int = 5):
    if aiohttp is None:
        print("aiohttp and numpy are required to run load tests. Install with pip install aiohttp numpy.")
        return

    print(f"=== Starting Load Test: {num_requests} requests (concurrency: {concurrency}) against {base_url} ===")
    connector = aiohttp.TCPConnector(limit=concurrency)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = []
        for i in range(num_requests):
            patient_id = f"patient_{i % 10:03d}"
            tasks.append(make_request(session, patient_id, token, base_url))

        start_time = time.time()
        results = await asyncio.gather(*tasks)
        duration = time.time() - start_time

        success_count = sum(1 for r in results if r["status"] == "success")
        latencies = [r["latency"] for r in results if r["status"] == "success"]

        print(f"Total Requests: {num_requests}")
        print(f"Successful: {success_count} ({success_count/num_requests*100:.1f}%)")
        print(f"Duration: {duration:.2f}s")
        if latencies:
            print(f"Average Latency: {sum(latencies)/len(latencies):.3f}s")
            print(f"Throughput: {len(latencies)/duration:.1f} req/s")


def main():
    parser = argparse.ArgumentParser(description="ReproCare Trends Load Test")
    parser.add_argument("--url", default="http://localhost:8100", help="Base URL of imaging service")
    parser.add_argument("--token", default="test-token", help="Bearer API key")
    parser.add_argument("--requests", type=int, default=20, help="Number of requests")
    parser.add_argument("--concurrency", type=int, default=5, help="Concurrency level")
    args = parser.parse_args()

    asyncio.run(run_load_test(args.url, args.token, args.requests, args.concurrency))


if __name__ == "__main__":
    main()
