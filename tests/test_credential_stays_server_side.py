"""Phase 0 rule 3: the pairing credential never reaches a browser.

Until 0.6.x it went out two ways: `get_connection_info` returned it, and the media browser's
thumbnail/playback URLs carried it as `?token=`. Both are checked here on the real handlers.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from homeassistant.components.media_source import MediaSourceItem
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.islautopia_doorbell import media_source, websocket_api
from custom_components.islautopia_doorbell.const import (
    CONF_CREDENTIAL, CONF_DEVICE_ID, CONF_HOST_HINT, DOMAIN,
)

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP


def _entrada(hass):
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=DEVICE_ID,
        data={CONF_DEVICE_ID: DEVICE_ID, CONF_CREDENTIAL: CREDENTIAL, CONF_HOST_HINT: LAN_IP},
    )
    entry.add_to_hass(hass)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {**entry.data, "sesion": object()}
    return entry


async def test_get_connection_info_carries_no_credential(hass, hass_ws_client):
    await async_setup_component(hass, "http", {})
    _entrada(hass)
    websocket_api.async_register_websocket_commands(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "islautopia_doorbell/get_connection_info",
                        "device_id": DEVICE_ID})
    msg = await ws.receive_json()
    assert msg["success"], msg
    texto = str(msg["result"])
    assert CREDENTIAL not in texto
    assert "credential" not in msg["result"]
    assert "relay" not in texto and "islautopia.com" not in texto
    assert msg["result"]["device_id"] == DEVICE_ID
    assert "live_timeout_entity" in msg["result"]

    await ws.send_json({"id": 2, "type": "islautopia_doorbell/get_turn_credentials",
                        "device_id": DEVICE_ID})
    msg = await ws.receive_json()
    assert not msg["success"]          # the command no longer exists


async def test_recording_urls_carry_no_credential_nor_cloud_name(hass):
    await async_setup_component(hass, "http", {})
    _entrada(hass)
    fuente = media_source.DoorbellMediaSource(hass)
    listado = {"total": 1, "offset": 0, "limit": 200, "capped": False,
               "items": [{"file": "01786903743_call.mp4", "type": "call", "ts": 1786903743, "size": 1000}]}
    with patch.object(media_source.api, "async_list_recordings", AsyncMock(return_value=listado)):
        nodo = await fuente.async_browse_media(MediaSourceItem(hass, DOMAIN, DEVICE_ID, None))
    hijo = nodo.children[0]
    assert CREDENTIAL not in hijo.thumbnail
    assert "islautopia.com" not in hijo.thumbnail
    assert hijo.thumbnail.startswith("/api/islautopia_doorbell/recording/")
    assert "authSig=" in hijo.thumbnail

    with patch.object(media_source.api, "async_check_recording_playable", AsyncMock()):
        play = await fuente.async_resolve_media(
            MediaSourceItem(hass, DOMAIN, f"{DEVICE_ID}/01786903743_call.mp4", None)
        )
    assert CREDENTIAL not in play.url
    assert "islautopia.com" not in play.url
    assert play.url.startswith("/api/islautopia_doorbell/recording/")
    assert "authSig=" in play.url      # the player gets it as is: unsigned was a 401 on HA 2026.9


async def test_recording_view_needs_auth_and_adds_the_credential_server_side(hass, hass_client, hass_client_no_auth):
    await async_setup_component(hass, "http", {})
    entry = _entrada(hass)
    pedidas = []

    class _Resp:
        status = 200
        headers = {"Content-Type": "video/mp4", "Content-Length": "4"}

        class content:
            @staticmethod
            async def iter_chunked(n):
                yield b"mp4!"

        def release(self):
            pass

    class _Sesion:
        async def get(self, url, **kw):
            pedidas.append(url)
            return _Resp()

    hass.data[DOMAIN][entry.entry_id]["sesion"] = _Sesion()
    from custom_components.islautopia_doorbell.recordings_view import (
        async_register_recordings_view, recording_path,
    )
    async_register_recordings_view(hass)

    anonimo = await hass_client_no_auth()
    r = await anonimo.get(recording_path(DEVICE_ID, "a.mp4"))
    assert r.status == 401
    assert pedidas == []

    cliente = await hass_client()
    r = await cliente.get(recording_path(DEVICE_ID, "a.mp4"))
    assert r.status == 200
    assert await r.read() == b"mp4!"
    assert len(pedidas) == 1 and f"token={CREDENTIAL}" in pedidas[0]
