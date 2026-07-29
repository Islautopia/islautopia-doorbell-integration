"""Thin async HTTP client for pairing and TURN credentials.

Deliberately NOT a general REST client for the doorbell's local dashboard API
(`/api/get_states`, `/api/firmware_info`, etc.) - this integration doesn't poll the doorbell at
all, see ARCHITECTURE.md §3 for why. Everything here is either:

  - called exactly once, during config flow pairing (async_get_device_id, async_login,
    async_pair_app, async_logout) - see config_flow.py, or
  - called on-demand by the card via websocket_api.py (async_get_app_turn_credentials).

See API_CONTRACT.md (IG_Doorbell repo) for the exact routes this talks to: §0 (device_id), §1.1
(login), §1.5 (pair_app), §3.1-bis (app_turn_credentials).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import aiohttp

from .const import DOORBELL_HOSTNAME_SUFFIX, RELAY_HOST, REQUEST_TIMEOUT

_LOGGER = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)


class DoorbellApiError(Exception):
    """Base error talking to a doorbell or the relay."""


class AuthenticationError(DoorbellApiError):
    """Wrong email/password, or a pair_app/app_turn_credentials credential was rejected."""


class DeviceNotPairedError(DoorbellApiError):
    """The doorbell itself is not registered with the cloud yet (409 device_not_paired)."""


class CloudAuthorizeFailedError(DoorbellApiError):
    """The cloud rejected registering the new app instance (502 cloud_authorize_failed)."""


@dataclass
class PairResult:
    device_id: str
    credential: str


def doorbell_hostname(device_id: str) -> str:
    """Public hostname that resolves to the doorbell's own LAN IP (real Let's Encrypt cert)."""
    return f"{device_id}.{DOORBELL_HOSTNAME_SUFFIX}"


async def async_get_device_id(session: aiohttp.ClientSession, host_or_ip: str) -> str:
    """GET /api/device_id (plain HTTP, port 80, no session needed) - first contact only.

    Deliberately the ONLY call in this module against a raw IP/host instead of the real
    `<device_id>.doorbell.islautopia.com` hostname - API_CONTRACT.md §0 documents this route as
    existing exactly for this: safe, read-only, no credentials involved. Never call
    async_login/async_pair_app against a raw IP - both of those always target the real
    hostname on purpose (see the contract's explicit warning against relaxing TLS hostname
    verification for anything sensitive).
    """
    url = f"http://{host_or_ip}/api/device_id"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                raise DoorbellApiError(f"GET /api/device_id -> HTTP {resp.status}")
            data = await resp.json(content_type=None)
    except aiohttp.ContentTypeError as err:
        raise DoorbellApiError("Response from /api/device_id is not valid JSON") from err
    device_id = data.get("device_id") if isinstance(data, dict) else None
    if not device_id:
        raise DoorbellApiError("Response from /api/device_id has no 'device_id'")
    return device_id


async def async_login(
    session: aiohttp.ClientSession, device_id: str, email: str, password: str
) -> None:
    """POST /api/login against the real hostname (HTTPS 8443) - sets a cookie on `session`.

    Transitory by design: the caller (config_flow.py) uses this session only long enough to
    call async_pair_app, then discards it and never persists email/password to disk.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/api/login"
    async with session.post(
        url,
        data={"email": email, "password": password},
        timeout=_TIMEOUT,
        allow_redirects=False,
    ) as resp:
        # Contract §1.1: 302 to "/" on success, 302 to "/login?error=1" on failure - there is
        # no JSON error body to parse, only the status/Location tell success from failure.
        location = resp.headers.get("Location", "")
        if resp.status != 302 or "error=1" in location:
            raise AuthenticationError("Wrong administrator email or password")


async def async_pair_app(
    session: aiohttp.ClientSession, device_id: str, label: str
) -> PairResult:
    """POST /api/pair_app - requires the session cookie async_login just set on `session`."""
    url = f"https://{doorbell_hostname(device_id)}:8443/api/pair_app"
    async with session.post(url, data={"label": label}, timeout=_TIMEOUT) as resp:
        if resp.status == 409:
            raise DeviceNotPairedError(
                "The doorbell is not paired with the cloud yet - wait for it to finish its own "
                "registration and try again"
            )
        if resp.status == 502:
            raise CloudAuthorizeFailedError(
                "The cloud rejected registering this app - try again later"
            )
        if resp.status != 200:
            raise DoorbellApiError(f"POST /api/pair_app -> HTTP {resp.status}")
        data = await resp.json(content_type=None)
    return PairResult(device_id=data["device_id"], credential=data["credential"])


async def async_logout(session: aiohttp.ClientSession, device_id: str) -> None:
    """POST /api/logout - best effort, frees one of the doorbell's 8 concurrent session slots."""
    url = f"https://{doorbell_hostname(device_id)}:8443/api/logout"
    try:
        async with session.post(url, timeout=_TIMEOUT):
            pass
    except aiohttp.ClientError:
        _LOGGER.debug("Best-effort logout failed for %s (non-blocking)", device_id)


async def async_get_app_turn_credentials(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> dict:
    """GET /device/<id>/app_turn_credentials on the relay, authenticated with the pair_app
    credential (never the device_secret, which this integration never has - contract §3.1-bis).

    Called on-demand by websocket_api.py right before the card starts a new WebRTC session -
    never cached longer than the card needs it for (TTL ~1h, server-issued).
    """
    url = f"https://{RELAY_HOST}/device/{device_id}/app_turn_credentials"
    headers = {"Authorization": f"Bearer {credential}"}
    async with session.get(url, headers=headers, timeout=_TIMEOUT) as resp:
        if resp.status == 401:
            raise AuthenticationError("Pairing credential is invalid or has been revoked")
        if resp.status == 403:
            raise DoorbellApiError("The doorbell itself is banned in the cloud")
        if resp.status == 503:
            raise DoorbellApiError("The cloud credential database is unavailable right now")
        if resp.status != 200:
            raise DoorbellApiError(f"GET app_turn_credentials -> HTTP {resp.status}")
        return await resp.json(content_type=None)
