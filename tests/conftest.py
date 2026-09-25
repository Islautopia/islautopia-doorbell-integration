"""Test harness: pytest-homeassistant-custom-component.

Run (from the repo root, in a Linux container with the harness installed):

    python -m pytest tests -q

The doorbell is never contacted: every network function is patched. What these tests measure is
the RULES of Phase 0 (LAN only, the credential never leaves the server, nothing half-configured,
translated entities, the live-view timeout entity). tools/mutantes.py flips each rule back and
checks that the suite goes red.
"""
from __future__ import annotations

import pytest

pytest_plugins = "pytest_homeassistant_custom_component"

DEVICE_ID = "97295a23721ab81b"
CREDENTIAL = "c" * 64
LAN_IP = "192.168.41.155"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield
