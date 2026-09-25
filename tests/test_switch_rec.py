"""The REC switch: `is_on` mirrors the doorbell's real `rec_state`, and no unload/reload leaks a
held signalling session.

RecSession itself is exercised against a fake doorbell in test_rec_session.py; here it is faked at
the class level, the same way test_credential_stays_server_side.py fakes the session object, so
these tests are about the ENTITY's plumbing: turn_on/turn_off, mirroring the doorbell's own state
instead of "a session is held", and cleaning up on unload.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.islautopia_doorbell import api, net
from custom_components.islautopia_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP


class _FakeRecSession:
    """Stands in for rec_session.RecSession: no network, driven by the test."""

    instancias: list["_FakeRecSession"] = []

    def __init__(self, sesion, device_id, credential, on_update):
        self.on_update = on_update
        self.recording = False
        self.kind = None
        self.origin = None
        self.closed = False
        self.parada = False
        _FakeRecSession.instancias.append(self)

    async def start(self):
        self.recording = True
        self.kind = "manual"
        self.origin = "manual"

    async def stop(self):
        self.parada = True
        self.closed = True
        self.recording = False
        self.on_update()

    def empujar_fin(self):
        """The doorbell ending the recording on its own, without anyone calling stop() (yet).

        Real RecSession (rec_session.py) does this in two steps too: `rec_state:false` flips
        `recording` and fires `on_update()` FIRST, and only then schedules its own `stop()` -
        `closed` stays False in between. Collapsing the two here would hide exactly the bug this
        fake exists to catch: a switch that reads "on" from "a session is held" instead of from
        `recording` would still look right if `closed` flipped at the very same instant.
        """
        self.recording = False
        self.on_update()


class _FakeRecSessionRefused(_FakeRecSession):
    async def start(self):
        raise api.NotAllowedError("admin_required")


async def _montar(hass):
    _FakeRecSession.instancias = []
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    estado = {"m": 1, "door_m": 0, "webrtc_clients": 2, "dname": "Test", "panel": 1, "reader": 0}
    with patch.object(net, "es_este_portero", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=estado)), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.100.0"})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", AsyncMock()):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


def _rec_entity_id(hass) -> str:
    reg = er.async_get(hass)
    return reg.async_get_entity_id("switch", DOMAIN, f"{DEVICE_ID}_rec")


async def test_turning_on_holds_a_session_and_reflects_its_real_state(hass):
    entry = await _montar(hass)
    ent = _rec_entity_id(hass)

    with patch("custom_components.islautopia_doorbell.switch.RecSession", _FakeRecSession):
        await hass.services.async_call("switch", "turn_on", {"entity_id": ent}, blocking=True)

    estado = hass.states.get(ent)
    assert estado.state == "on"
    assert estado.attributes["kind"] == "manual"
    assert estado.attributes["origin"] == "manual"
    assert len(_FakeRecSession.instancias) == 1


async def test_turning_off_stops_the_held_session(hass):
    entry = await _montar(hass)
    ent = _rec_entity_id(hass)

    with patch("custom_components.islautopia_doorbell.switch.RecSession", _FakeRecSession):
        await hass.services.async_call("switch", "turn_on", {"entity_id": ent}, blocking=True)
        await hass.services.async_call("switch", "turn_off", {"entity_id": ent}, blocking=True)

    assert hass.states.get(ent).state == "off"
    assert _FakeRecSession.instancias[-1].parada


async def test_the_doorbell_ending_the_recording_turns_the_switch_off_by_itself(hass):
    """Point 2 of the encargo: the exposed state is the doorbell's real `rec_state`, never
    "a session is (still) held" - a 10-minute cap or another admin has to show up here too.

    Checked at the exact instant `recording` flips but nothing has closed the session yet - the
    window a switch reading "a session is held" instead of the real `rec_state` would miss.
    """
    entry = await _montar(hass)
    ent = _rec_entity_id(hass)

    with patch("custom_components.islautopia_doorbell.switch.RecSession", _FakeRecSession):
        await hass.services.async_call("switch", "turn_on", {"entity_id": ent}, blocking=True)
        assert hass.states.get(ent).state == "on"

        sesion = _FakeRecSession.instancias[-1]
        sesion.empujar_fin()
        await hass.async_block_till_done()
        assert hass.states.get(ent).state == "off"
        assert not sesion.closed  # still held at this instant - only `recording` changed

        await sesion.stop()      # what the real RecSession schedules next, to free the slot
        await hass.async_block_till_done()

    assert hass.states.get(ent).state == "off"


async def test_a_refusal_never_leaves_the_switch_on(hass):
    entry = await _montar(hass)
    ent = _rec_entity_id(hass)

    with patch("custom_components.islautopia_doorbell.switch.RecSession", _FakeRecSessionRefused):
        with pytest.raises(HomeAssistantError):
            await hass.services.async_call("switch", "turn_on", {"entity_id": ent}, blocking=True)

    assert hass.states.get(ent).state == "off"


async def test_unloading_the_entry_closes_an_open_rec_session_no_leak(hass):
    """Point 1's "sin fugas": a Home Assistant restart or a reload must not leave the doorbell
    holding a signalling slot for a recording nobody is watching any more."""
    entry = await _montar(hass)
    ent = _rec_entity_id(hass)

    with patch("custom_components.islautopia_doorbell.switch.RecSession", _FakeRecSession):
        await hass.services.async_call("switch", "turn_on", {"entity_id": ent}, blocking=True)
    sesion = _FakeRecSession.instancias[-1]
    assert not sesion.parada

    with patch.object(api, "async_set_hass_config", AsyncMock()):
        assert await hass.config_entries.async_unload(entry.entry_id)

    assert sesion.parada
