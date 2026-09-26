"""The mode select publishes what the doorbell confirms AT ONCE, and says so when it did not apply.

0.7.4 (Inaki, 2026-09-25): "the mode button is quite lazy showing the new mode ... sometimes it
looks like it did not work". Until 0.7.3 the select relied on `async_request_refresh()`, whose
10 s debouncer delayed a SECOND change made within 10 s of the first - exactly the "I tapped
twice and it did not move" case. These tests pin both halves: the confirmed value shows up before
the service call returns, even for back-to-back changes, and a write the doorbell dropped in
silence fails loudly while the entity keeps showing the doorbell's real mode.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ig_doorbell import api, net
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP


class _FakeDoorbell:
    """A fake doorbell: save_states writes `m` unless told to drop it, get_states reads it back."""

    def __init__(self) -> None:
        self.state = {"m": 0, "door_m": 0, "webrtc_clients": 1, "dname": "Test"}
        self.ignore_writes = False

    async def get_states(self, *_a, **_k):
        return dict(self.state)

    async def save_states(self, _session, _device_id, _credential, fields):
        if not self.ignore_writes:
            self.state["m"] = int(fields["m"])


async def _setup(hass, doorbell: _FakeDoorbell):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(side_effect=doorbell.get_states)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.100.0"})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", AsyncMock()):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return er.async_get(hass).async_get_entity_id("select", DOMAIN, f"{DEVICE_ID}_mode")


async def _choose(hass, ent, option, doorbell):
    with patch.object(api, "async_get_states", AsyncMock(side_effect=doorbell.get_states)), \
         patch.object(api, "async_save_states", AsyncMock(side_effect=doorbell.save_states)):
        await hass.services.async_call(
            "select", "select_option", {"entity_id": ent, "option": option}, blocking=True
        )


async def test_back_to_back_changes_show_at_once(hass):
    doorbell = _FakeDoorbell()
    ent = await _setup(hass, doorbell)
    assert hass.states.get(ent).state == "normal"

    await _choose(hass, ent, "away", doorbell)
    assert hass.states.get(ent).state == "away"
    # The second change inside the old debouncer's 10 s window: this is the one that used to wait.
    await _choose(hass, ent, "do_not_disturb", doorbell)
    assert hass.states.get(ent).state == "do_not_disturb"


async def test_a_change_the_doorbell_dropped_fails_and_keeps_the_real_mode(hass):
    doorbell = _FakeDoorbell()
    ent = await _setup(hass, doorbell)
    doorbell.ignore_writes = True

    with pytest.raises(HomeAssistantError):
        await _choose(hass, ent, "away", doorbell)
    assert hass.states.get(ent).state == "normal"


async def test_a_refused_change_fails_and_keeps_the_mode(hass):
    doorbell = _FakeDoorbell()
    ent = await _setup(hass, doorbell)

    with patch.object(api, "async_save_states", AsyncMock(side_effect=api.NotAllowedError("x"))):
        with pytest.raises(HomeAssistantError):
            await hass.services.async_call(
                "select", "select_option", {"entity_id": ent, "option": "away"}, blocking=True
            )
    assert hass.states.get(ent).state == "normal"
