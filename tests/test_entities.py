"""Phase 0 rule 4 (English names + translations) and the live-view timeout entity.

The entry is set up for real with the network patched out, so this also proves the platforms load.
"""
from __future__ import annotations

import json
import pathlib
from unittest.mock import AsyncMock, patch

from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.islautopia_doorbell import api, const, net
from custom_components.islautopia_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

RAIZ = pathlib.Path(const.__file__).parent
IDIOMAS = ["en", "es", "pt", "de", "fr", "ru", "zh-Hans", "hi", "ar"]


async def _montar(hass):
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
         patch.object(api, "async_set_hass_config", AsyncMock()):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


async def test_every_entity_has_a_translation_key_and_english_name(hass):
    entry = await _montar(hass)
    reg = er.async_get(hass)
    entidades = er.async_entries_for_config_entry(reg, entry.entry_id)
    assert len(entidades) == 12
    en = json.loads((RAIZ / "translations" / "en.json").read_text(encoding="utf-8"))["entity"]
    for e in entidades:
        assert e.translation_key, e.entity_id
        assert e.translation_key in en[e.domain], (e.domain, e.translation_key)
        estado = hass.states.get(e.entity_id)
        # friendly name = device name + the ENGLISH translation (test hass runs in English)
        assert estado.attributes["friendly_name"] == f"Test {en[e.domain][e.translation_key]['name']}"


async def test_mode_state_is_a_stable_key_with_translated_label(hass):
    await _montar(hass)
    reg = er.async_get(hass)
    mode = reg.async_get_entity_id("select", DOMAIN, f"{DEVICE_ID}_modo")
    st = hass.states.get(mode)
    assert st.state == "away"
    assert st.attributes["options"] == ["normal", "away", "do_not_disturb", "custom"]


async def test_live_view_timeout_default_and_bounds(hass):
    await _montar(hass)
    reg = er.async_get(hass)
    ent = reg.async_get_entity_id("number", DOMAIN, f"{DEVICE_ID}_live_timeout")
    st = hass.states.get(ent)
    assert float(st.state) == 120
    assert st.attributes["min"] == 0          # 0 = disabled
    assert st.attributes["unit_of_measurement"] == "s"
    await hass.services.async_call("number", "set_value", {"entity_id": ent, "value": 300}, blocking=True)
    assert float(hass.states.get(ent).state) == 300


def test_all_languages_translate_every_entity():
    en = json.loads((RAIZ / "translations" / "en.json").read_text(encoding="utf-8"))["entity"]
    for lang in IDIOMAS:
        d = json.loads((RAIZ / "translations" / f"{lang}.json").read_text(encoding="utf-8"))["entity"]
        for dominio, claves in en.items():
            for clave, cont in claves.items():
                assert d[dominio][clave]["name"], (lang, dominio, clave)
                if "state" in cont:
                    assert set(d[dominio][clave]["state"]) == set(cont["state"]), (lang, clave)
    strings = json.loads((RAIZ / "strings.json").read_text(encoding="utf-8"))
    assert strings == json.loads((RAIZ / "translations" / "en.json").read_text(encoding="utf-8"))
