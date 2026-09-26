"""The doorbell may only act on the entities this integration gave it, and hears whether it happened.

0.7.6 (Inaki, 2026-09-25): the door (`ha_e`) and the `hass` step of a sequence are picked from a
list of at most 5 on/off entities chosen here and pushed to the doorbell (contract 4). These tests
pin the integration's half of the defence on both sides:

- an order for an entity NOT in this entry's list is refused and nothing is called, even though the
  doorbell asked for it;
- a listed entity is actually switched, `ok: true` comes back in the webhook answer, and a lock maps
  "on" to `lock.unlock`;
- the list pushed to the doorbell keeps only the allowed domains and at most 5, with `domain`.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from homeassistant.core import ServiceCall
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry, async_mock_service

from custom_components.ig_doorbell import api, net, webhook
from custom_components.ig_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_ENTITIES, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP

WID = webhook.webhook_id_for(DEVICE_ID)


async def _setup(hass, entities: list[str], state: dict | None = None):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
        options={CONF_ENTITIES: entities},
    )
    entry.add_to_hass(hass)
    push = AsyncMock()
    with patch.object(net, "is_this_doorbell", AsyncMock(return_value=True)), \
         patch.object(api, "async_get_states", AsyncMock(return_value=state or {"m": 0, "door_m": 1})), \
         patch.object(api, "async_get_firmware_info", AsyncMock(return_value={"fw_version": "0.100.4"})), \
         patch.object(api, "async_get_role", AsyncMock(return_value="admin")), \
         patch.object(api, "async_set_hass_config", push):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry, push


async def test_refuses_an_entity_outside_its_list(hass):
    await _setup(hass, ["input_boolean.prueba"])
    hass.states.async_set("switch.otra", "off")
    calls = async_mock_service(hass, "switch", "turn_on")

    done, error = await webhook._act_on_entity(hass, WID, "switch.otra", True)

    assert (done, error) == (False, "not_listed")
    assert calls == []


async def test_acts_on_a_listed_entity_and_confirms(hass):
    await _setup(hass, ["input_boolean.prueba", "lock.puerta"])
    hass.states.async_set("input_boolean.prueba", "off")
    hass.states.async_set("lock.puerta", "locked")
    on: list[ServiceCall] = async_mock_service(hass, "input_boolean", "turn_on")
    unlock_calls: list[ServiceCall] = async_mock_service(hass, "lock", "unlock")

    assert await webhook._act_on_entity(hass, WID, "input_boolean.prueba", True) == (True, None)
    assert [c.data["entity_id"] for c in on] == ["input_boolean.prueba"]

    # In a lock, "on" is OPEN.
    assert await webhook._act_on_entity(hass, WID, "lock.puerta", True) == (True, None)
    assert [c.data["entity_id"] for c in unlock_calls] == ["lock.puerta"]


async def test_says_so_when_the_entity_is_missing_or_unavailable(hass):
    await _setup(hass, ["light.porche", "switch.caido"])
    hass.states.async_set("switch.caido", "unavailable")
    assert await webhook._act_on_entity(hass, WID, "light.porche", True) == (False, "entity_missing")
    assert await webhook._act_on_entity(hass, WID, "switch.caido", True) == (False, "entity_unavailable")


async def test_pushes_only_allowed_domains_at_most_five_with_domain(hass):
    chosen = ["button.timbre", "light.a", "light.b", "switch.c", "fan.d", "siren.e", "lock.f"]
    _entry, push = await _setup(hass, chosen)
    entity_list = push.call_args.kwargs["entities"]
    assert [e["id"] for e in entity_list] == ["light.a", "light.b", "switch.c", "fan.d", "siren.e"]
    assert all(e["domain"] == e["id"].split(".")[0] for e in entity_list)


async def test_the_entity_that_already_opens_the_door_is_adopted(hass):
    """Updating from 0.7.5 must not leave the door shut: its hand-written `ha_e` joins the list."""
    entry, push = await _setup(hass, [], {"m": 0, "door_m": 1, "ha_e": "lock.entrada"})
    assert entry.options[CONF_ENTITIES] == ["lock.entrada"]
    assert [e["id"] for e in push.call_args.kwargs["entities"]] == ["lock.entrada"]


async def test_a_door_entity_of_a_refused_domain_is_not_adopted(hass):
    entry, _ = await _setup(hass, [], {"m": 0, "door_m": 1, "ha_e": "script.abrir"})
    assert entry.options[CONF_ENTITIES] == []
