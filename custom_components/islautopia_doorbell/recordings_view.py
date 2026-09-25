"""Recordings reach the browser through Home Assistant, and the pairing credential stays here.

## The defect this closes (Phase 0 of the parity plan, 2026-09-25)

Until 0.6.x, `media_source` handed the browser a URL straight to the doorbell:

    https://<device_id>.doorbell.islautopia.com:8443/api/recording?file=...&token=<credential>

Two faults in one line. The **pairing credential** — the key that opens the door and changes the
doorbell's settings — landed in the browser of **every** Home Assistant user who opened the media
browser, including non-admin users, and in their history and caches. And the browser had to resolve
the doorbell's public name through our cloud's DNS to play a file from a device in the same house.

Now the browser gets a Home Assistant URL, signed like every other HA media URL, and this view
fetches the file from the doorbell over the LAN session (net.py) adding the credential server-side.

## What passes through, and why that is acceptable

The MP4 bytes do pass through Home Assistant now. They are streamed chunk by chunk (never held in
memory), and `Range` is forwarded both ways, so seeking works as before. It is the same machine on
the same LAN, and it is what the rule "the credential never reaches a browser" costs.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from urllib.parse import quote

import aiohttp
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant, callback

from . import api
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN

_LOGGER = logging.getLogger(__name__)

RECORDINGS_URL = "/api/islautopia_doorbell/recording"

# Thumbnails are listed in the media browser and loaded later by <img>, so their signature must
# outlive a browsing session. Playback URLs are signed by Home Assistant itself when it resolves the
# media (media_source signs relative URLs), so they do not use this.
_THUMB_TTL = timedelta(hours=12)
# Long enough to watch and seek a recording (minutes long) after opening it; short enough that a
# copied URL stops working the same day.
_VIDEO_TTL = timedelta(hours=2)

_STREAM_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_read=60)
_FORWARD_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")


@callback
def async_register_recordings_view(hass: HomeAssistant) -> None:
    hass.http.register_view(DoorbellRecordingView)


def recording_path(device_id: str, filename: str, kind: str = "video") -> str:
    """The Home Assistant path of a recording (unsigned). No credential in it, ever."""
    return f"{RECORDINGS_URL}/{device_id}?kind={kind}&file={quote(filename, safe='')}"


@callback
def signed_thumbnail_url(hass: HomeAssistant, device_id: str, filename: str) -> str:
    return async_sign_path(hass, recording_path(device_id, filename, "thumb"), _THUMB_TTL)


@callback
def signed_video_url(hass: HomeAssistant, device_id: str, filename: str) -> str:
    """Signed playback URL. ⚠️ Signed HERE: the media_source resolve result reaches the player as
    is (measured on HA 2026.9.3: an unsigned path came back 401 to the player)."""
    return async_sign_path(hass, recording_path(device_id, filename, "video"), _VIDEO_TTL)


def _entry_data(hass: HomeAssistant, device_id: str) -> dict | None:
    stored = hass.data.get(DOMAIN, {})
    for entry in hass.config_entries.async_entries(DOMAIN):
        data = stored.get(entry.entry_id)
        if isinstance(data, dict) and data.get(CONF_DEVICE_ID) == device_id:
            return data
    return None


class DoorbellRecordingView(HomeAssistantView):
    """GET a recording or its thumbnail from the doorbell, credential added here."""

    url = f"{RECORDINGS_URL}/{{device_id}}"
    name = "api:islautopia_doorbell:recording"
    requires_auth = True   # an HA session or a signed path; never anonymous

    async def get(self, request: web.Request, device_id: str) -> web.StreamResponse:
        hass: HomeAssistant = request.app["hass"]
        data = _entry_data(hass, device_id)
        if data is None or "sesion" not in data:
            return web.Response(status=404, text="Doorbell not configured here")
        filename = request.query.get("file", "")
        kind = request.query.get("kind", "video")
        if not filename or kind not in ("video", "thumb"):
            return web.Response(status=400, text="Bad recording reference")

        builder = api.recording_url if kind == "video" else api.thumbnail_url
        url = builder(device_id, data[CONF_CREDENTIAL], filename)
        headers = {}
        if rango := request.headers.get("Range"):
            headers["Range"] = rango

        sesion: aiohttp.ClientSession = data["sesion"]
        try:
            upstream = await sesion.get(url, headers=headers, timeout=_STREAM_TIMEOUT)
        except (aiohttp.ClientError, OSError, TimeoutError) as err:
            _LOGGER.debug("Recording %s from %s: doorbell unreachable: %s", filename, device_id, err)
            return web.Response(status=502, text="Doorbell unreachable from Home Assistant")

        if upstream.status not in (200, 206):
            upstream.release()
            textos = {
                401: "The doorbell rejected this pairing credential. Re-pair it.",
                403: "This pairing is not an administrator of the doorbell: it cannot download recordings.",
                404: "That recording no longer exists on the doorbell.",
            }
            return web.Response(
                status=upstream.status if upstream.status in textos else 502,
                text=textos.get(upstream.status, f"Doorbell returned {upstream.status}"),
            )

        response = web.StreamResponse(status=upstream.status)
        for nombre in _FORWARD_HEADERS:
            if nombre in upstream.headers:
                response.headers[nombre] = upstream.headers[nombre]
        # Recordings are private: no shared cache may keep them.
        response.headers["Cache-Control"] = "private, max-age=300"
        await response.prepare(request)
        try:
            async for chunk in upstream.content.iter_chunked(64 * 1024):
                await response.write(chunk)
        except (aiohttp.ClientError, ConnectionResetError, TimeoutError) as err:
            _LOGGER.debug("Recording stream %s ended early: %s", filename, err)
        finally:
            upstream.release()
        return response
