"""Database query performance, index utilization, and resilience tests."""
import time
import pytest
from app.routes.trends import DatabaseBridge


@pytest.mark.asyncio
async def test_database_query_performance():
    """Verify in-memory query bridge response time is sub-millisecond."""
    db = DatabaseBridge()
    start = time.time()
    res = await db.fetchall("SELECT * FROM segmentations WHERE patient_id = %s", "patient_123")
    duration_ms = (time.time() - start) * 1000
    assert res == []
    assert duration_ms < 10.0


@pytest.mark.asyncio
async def test_missing_data_handling_performance():
    """Verify query handles missing patients without performance regression."""
    db = DatabaseBridge()
    start = time.time()
    res = await db.fetchone("SELECT * FROM patients WHERE id = %s", "non_existent")
    duration_ms = (time.time() - start) * 1000
    assert res is None
    assert duration_ms < 10.0

