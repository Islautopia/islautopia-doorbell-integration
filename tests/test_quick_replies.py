"""Quick-reply list exposed to the Lovelace card (`?quick=1`, contract §1.18.8).

Two layers, like the rest of this suite: `api.async_list_quick_replies` against a faked aiohttp
session (no real doorbell), and the websocket command against the real handler with a fake
config entry - the same two-layer split `test_signal_actions.py`/`test_credential_stays_server_side.py`
already use.
"""
from __future__ import annotations

import json

import pytest
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.islautopia_doorbell import api, websocket_api
from custom_components.islautopia_doorbell.const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN

from .conftest import CREDENTIAL, DEVICE_ID


class _FakeResp:
    def __init__(self, status: int, body: dict | None):
        self.status = status
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def json(self, content_type=None):
        return self._body


class _FakeSession:
    def __init__(self, status: int, body: dict | None):
        self.status = status
        self.body = body
        self.urls: list[str] = []

    def get(self, url, **kw):
        self.urls.append(url)
        return _FakeResp(self.status, self.body)


async def test_async_list_quick_replies_reads_the_reduced_list():
    body = {"quick_replies": [{"id": 7, "label": "Un momento, por favor", "steps": 1},
                               {"id": 9, "label": "Deje el paquete en la puerta", "steps": 2}]}
    fake = _FakeSession(200, body)
    items = await api.async_list_quick_replies(fake, DEVICE_ID, CREDENTIAL)
    assert items == body["quick_replies"]
    assert fake.urls[0].startswith(
        f"https://{DEVICE_ID}.doorbell.islautopia.com:8443/api/sequences?quick=1&token="
    )


async def test_async_list_quick_replies_401_is_authentication_error():
    fake = _FakeSession(401, None)
    with pytest.raises(api.AuthenticationError):
        await api.async_list_quick_replies(fake, DEVICE_ID, CREDENTIAL)


async def test_async_list_quick_replies_tolerates_a_missing_or_malformed_key():
    for body in (None, {}, {"quick_replies": "not-a-list"}):
        fake = _FakeSession(200, body)
        assert await api.async_list_quick_replies(fake, DEVICE_ID, CREDENTIAL) == []


def _entrada(hass):
    entry = MockConfigEntry(
        domain=DOMAIN, unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL},
    )
    entry.add_to_hass(hass)
    return entry


async def test_ws_get_quick_replies_returns_the_list_and_no_credential(hass, hass_ws_client, monkeypatch):
    await async_setup_component(hass, "http", {})
    entry = _entrada(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {**entry.data, "sesion": object()}

    body = [{"id": 7, "label": "Un momento, por favor", "steps": 1}]

    async def _fake_list(session, device_id, credential):
        assert device_id == DEVICE_ID
        assert credential == CREDENTIAL
        return body

    monkeypatch.setattr(api, "async_list_quick_replies", _fake_list)
    websocket_api.async_register_websocket_commands(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "islautopia_doorbell/get_quick_replies",
                        "device_id": DEVICE_ID})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"]["quick_replies"] == body
    assert CREDENTIAL not in json.dumps(msg["result"])


async def test_ws_get_quick_replies_not_found_for_unknown_device(hass, hass_ws_client):
    await async_setup_component(hass, "http", {})
    websocket_api.async_register_websocket_commands(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "islautopia_doorbell/get_quick_replies",
                        "device_id": "no-existe"})
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"


async def test_ws_get_quick_replies_surfaces_an_unreachable_doorbell(hass, hass_ws_client, monkeypatch):
    await async_setup_component(hass, "http", {})
    entry = _entrada(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {**entry.data, "sesion": object()}

    async def _boom(session, device_id, credential):
        raise api.DoorbellApiError("no route to host")

    monkeypatch.setattr(api, "async_list_quick_replies", _boom)
    websocket_api.async_register_websocket_commands(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "islautopia_doorbell/get_quick_replies",
                        "device_id": DEVICE_ID})
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unreachable"
