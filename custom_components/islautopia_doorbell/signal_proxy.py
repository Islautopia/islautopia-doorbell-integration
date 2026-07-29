"""Home Assistant relays the doorbell's WebRTC signalling for the card. Media does not pass here.

## Why this exists

The card runs in a browser and needs to talk to the doorbell's local signalling endpoints. It
cannot do what the iOS and Android apps do — connect to the doorbell's IP and validate its
certificate against the expected hostname — because no browser exposes that. So the card has to
use the public hostname `<device_id>.doorbell.islautopia.com`, which resolves to a private LAN
address.

That combination is exactly the shape of a DNS-rebinding attack, and iCloud Private Relay blocks
it on purpose. Nearly every iPhone has Private Relay on by default, and the Home Assistant
companion app is where most people open a dashboard on a phone. So the local path was failing for
the largest single group of users, and falling back to the cloud relay — slower, and routing media
through a server in Germany for two devices sitting in the same house.

Home Assistant is already an origin the browser has resolved and trusts. Proxying the signalling
through it removes the hostname, the certificate and Private Relay from the problem in one move.

## What does NOT pass through here, and why that matters

**Only signalling.** A few kilobytes of SDP and ICE candidates per session.

The media stays peer-to-peer. The doorbell offers its own LAN address as an ICE host candidate; a
phone on that same network reaches it directly over UDP, and Private Relay does not touch local
UDP at all. So this recovers the fast direct path rather than replacing it with a slower one —
Home Assistant never sees a video frame, and would be a poor place to put one.

Verified on real hardware before this was written: a browser session on the doorbell's LAN selects
the `host <-> host` candidate pair with a 2 ms round trip. The direct path works; only the
signalling needed rescuing.

## A requirement, decided rather than discovered (2026-07-29)

**Home Assistant and the doorbell are always on the same LAN, and must be able to reach each
other.** Different VLANs are fine; anyone who segments their network can route one to the other.
This is a stated install requirement, not a hope.

It is worth naming because it removes a whole tier of guesswork. An earlier sketch had three
paths: proxy through Home Assistant, browser connecting directly, then relay — with the card
somehow deciding between them. With this requirement there are two, and the choice is not a guess:
if the viewer is on the LAN the proxy works, and if it does not work the doorbell is off. No
three-second blind wait, which is what the card does today and the reason it feels slow.

## Authentication

`EventSource` cannot set an Authorization header — the same limitation that made the firmware
accept `?token=` in its query string (API_CONTRACT.md §1.4). Home Assistant's answer to this is
signed paths, which is what its own camera streams use: the card asks over the authenticated
WebSocket for a short-lived signed URL and opens `EventSource` on that.

The pairing credential never reaches browser JavaScript. It stays here, server-side, and is
attached when this module talks to the doorbell. That is a genuine improvement over the card
holding the raw 64-hex credential, which is what it does today.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp
from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.auth import async_sign_path
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import doorbell_hostname
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN

_LOGGER = logging.getLogger(__name__)

SIGNAL_PROXY_URL = "/api/islautopia_doorbell/signal"

# How long a signed URL stays usable. Long enough to cover a slow page load or a user who opens a
# dashboard and walks away before the card mounts; short enough that a URL leaking into a log or a
# shared screenshot stops working the same day. The session it opens is not bounded by this — once
# the EventSource is connected it stays connected.
_SIGNED_URL_TTL = timedelta(minutes=30)

# The doorbell holds an SSE connection open indefinitely, sending a heartbeat every few seconds.
# No total timeout, therefore: only a connect timeout, so an unreachable doorbell fails quickly
# instead of hanging the request. A total timeout here would silently kill live sessions at
# whatever interval we picked.
_SSE_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=10, sock_connect=10)
_POST_TIMEOUT = aiohttp.ClientTimeout(total=10)


@callback
def async_register_signal_proxy(hass: HomeAssistant) -> None:
    """Register the proxy view. Safe to call more than once."""
    hass.http.register_view(DoorbellSignalProxyView)


@callback
def async_signed_signal_url(hass: HomeAssistant, device_id: str) -> str:
    """A short-lived URL the card can hand to EventSource without an auth header."""
    return async_sign_path(hass, f"{SIGNAL_PROXY_URL}/{device_id}", _SIGNED_URL_TTL)


def _entry_data(hass: HomeAssistant, device_id: str) -> dict | None:
    """Stored data for a paired doorbell, found by asking which config entries exist.

    Same reasoning as `_find_entry_data` in websocket_api.py: walking `hass.data[DOMAIN]` values
    would also examine the shared MQTT listener state, which is a plain dict too.
    """
    stored = hass.data.get(DOMAIN, {})
    for entry in hass.config_entries.async_entries(DOMAIN):
        data = stored.get(entry.entry_id)
        if isinstance(data, dict) and data.get(CONF_DEVICE_ID) == device_id:
            return data
    return None


class DoorbellSignalProxyView(HomeAssistantView):
    """GET streams the doorbell's SSE to the card; POST forwards the card's replies to it."""

    url = f"{SIGNAL_PROXY_URL}/{{device_id}}"
    name = "api:islautopia_doorbell:signal"
    # Signed paths satisfy this without an Authorization header, which EventSource cannot send.
    requires_auth = True

    async def get(self, request: web.Request, device_id: str) -> web.StreamResponse:
        """Stream the doorbell's signalling events straight through to the card."""
        hass: HomeAssistant = request.app["hass"]
        data = _entry_data(hass, device_id)
        if data is None:
            return web.Response(status=404, text="Doorbell not configured here")

        url = (
            f"https://{doorbell_hostname(device_id)}:8443"
            f"/webrtc/signal?token={data[CONF_CREDENTIAL]}"
        )
        session = async_get_clientsession(hass)

        try:
            upstream = await session.get(url, timeout=_SSE_TIMEOUT)
        except aiohttp.ClientError as err:
            # Overwhelmingly "this Home Assistant cannot reach the doorbell" - a different VLAN, or
            # the doorbell is off. 502 rather than 500: the failure is upstream, not here, and the
            # card decides between its remaining paths on that distinction.
            _LOGGER.debug("Signal proxy could not reach doorbell %s: %s", device_id, err)
            return web.Response(status=502, text="Doorbell unreachable from Home Assistant")

        if upstream.status != 200:
            upstream.release()
            if upstream.status == 401:
                # The pairing credential was revoked or the doorbell was factory reset. Passed
                # through as-is so the card can say "re-pair" instead of "try again later".
                return web.Response(status=401, text="Pairing credential rejected")
            return web.Response(status=502, text=f"Doorbell returned {upstream.status}")

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                # Named explicitly because a reverse proxy in front of Home Assistant that buffers
                # this stream would hold the SDP offer until its buffer filled - which for a few
                # hundred bytes means indefinitely. The session would simply never start, with
                # nothing in any log to explain it.
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)

        try:
            # Forwarded as raw chunks rather than parsed events: this proxy has no business
            # understanding the signalling schema. Anything the firmware adds later passes through
            # without a change here, and there is no parser to disagree with the card's.
            async for chunk in upstream.content.iter_any():
                await response.write(chunk)
        except (aiohttp.ClientError, ConnectionResetError, TimeoutError) as err:
            # Normal: the user closed the tab, or the doorbell dropped the session. Debug, not a
            # warning - it would otherwise fill the log on every ordinary page navigation.
            _LOGGER.debug("Signal stream for %s ended: %s", device_id, err)
        finally:
            # Both sides always: leaving the upstream connection open would hold one of the
            # doorbell's four session slots for its full abandonment timeout, and slots are the
            # scarcest thing it has.
            upstream.release()

        return response

    async def post(self, request: web.Request, device_id: str) -> web.Response:
        """Forward the card's answer/candidate/bye to the doorbell."""
        hass: HomeAssistant = request.app["hass"]
        data = _entry_data(hass, device_id)
        if data is None:
            return web.Response(status=404, text="Doorbell not configured here")

        body = await request.read()
        url = (
            f"https://{doorbell_hostname(device_id)}:8443"
            f"/webrtc/signal/post?token={data[CONF_CREDENTIAL]}"
        )
        session = async_get_clientsession(hass)

        try:
            async with session.post(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                timeout=_POST_TIMEOUT,
            ) as resp:
                text = await resp.text()
                return web.Response(status=resp.status, text=text)
        except aiohttp.ClientError as err:
            _LOGGER.debug("Signal POST to %s failed: %s", device_id, err)
            return web.Response(status=502, text="Doorbell unreachable from Home Assistant")
