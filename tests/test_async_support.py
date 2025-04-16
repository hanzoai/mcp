"""Basic test for asyncio support."""

import asyncio
import pytest


def test_sync():
    """Simple synchronous test to verify basic testing works."""
    assert 1 + 1 == 2


@pytest.mark.asyncio
async def test_async_simple():
    """Simple async test to verify asyncio support."""
    await asyncio.sleep(0.001)
    assert 1 + 1 == 2


@pytest.mark.asyncio
async def test_async_manual():
    """Run async code to verify it works."""
    await asyncio.sleep(0.001)
    result = 2
    assert result == 2
