"""Reach the doorbell at its LAN address, and ONLY there.

## The rule (Iñaki, 2026-09-25 — Phase 0 of the parity plan)

Home Assistant is a **local** client. The integration talks to the doorbell over direct IP on the
LAN and never through anything of ours on the internet: no relay, no TURN, **and no public DNS** —
the record `<device_id>.doorbell.islautopia.com` is maintained by our cloud, so resolving it is
talking to the VPS by another name. If there is no direct IP connectivity, the configuration is not
viable, and setup says so (config_flow.py) instead of half-working through the cloud.

Until 0.6.x this module returned the LAN address first **and then whatever public DNS said**, as a
fallback. That fallback is gone on purpose. Do not bring it back to "survive a DHCP move": a moved
doorbell is found again by zeroconf (config_flow.async_step_zeroconf updates the stored address) or
by the user in the options flow ("Doorbell address"), both of which stay inside the LAN.

## Why the URLs still carry the public hostname

Because that is the name the doorbell's certificate is issued for, and the contract (§0) is explicit
about the shape of a LAN connection: connect to the IP and **validate the certificate against the
expected hostname**, never relax the check. So:

    url          https://<device_id>.doorbell.islautopia.com:8443/...   <- SNI + cert validation
    connects to  192.168.x.y                                            <- this resolver, always

The name in the URL is never looked up. `LanOnlyResolver.resolve()` answers from its map and
**raises for any name it does not know** — it has no DNS resolver inside at all, so there is no code
path left through which a query for `*.islautopia.com` could leave this machine.

A stale address pointing at a live machine that is not the doorbell cannot be trusted by accident:
that machine has no certificate for the doorbell's name and the TLS handshake fails.
"""
from __future__ import annotations

import logging
import socket
from ipaddress import ip_address

import aiohttp
from aiohttp.abc import AbstractResolver

from homeassistant.core import HomeAssistant
from homeassistant.util.ssl import client_context

_LOGGER = logging.getLogger(__name__)


class NotOnTheLanError(OSError):
    """A name this integration has no LAN address for. Never resolved anywhere else."""


class LanOnlyResolver(AbstractResolver):
    """Resolve the doorbell's certificate name to its stored LAN address. Nothing else, ever."""

    def __init__(self, address_map: dict[str, str]) -> None:
        # Read once and kept: a new address arrives as a config-entry update, which reloads the
        # integration, which closes this session and builds another.
        for name, address in address_map.items():
            # Only literal addresses may go in. The first LAN-first resolver once stored a NAME
            # here, and everything kept working through DNS as if the fix were in place.
            ip_address(address)
        self._address_map = dict(address_map)

    async def resolve(
        self, host: str, port: int = 0, family: int = socket.AF_INET
    ) -> list[dict]:
        lan = self._address_map.get(host)
        if lan is None:
            # ⚠️ No DNS fallback, by rule (module docstring). Raising here is the whole point.
            raise NotOnTheLanError(
                f"{host} has no LAN address in this integration; it is never looked up in DNS"
            )
        return [
            {
                "hostname": host,
                "host": lan,
                "port": port,
                "family": socket.AF_INET6 if ":" in lan else socket.AF_INET,
                "proto": 0,
                "flags": 0,
            }
        ]

    async def close(self) -> None:
        return None


def create_session(hass: HomeAssistant, address_map: dict[str, str]) -> aiohttp.ClientSession:
    """A session for one doorbell, with the LAN-only resolver on it.

    ⚠️ NOT `async_get_clientsession(hass)`: that one is shared with every other integration and
    resolves through DNS. This one is per config entry and **must be closed in
    `async_unload_entry`**.
    """
    connector = aiohttp.TCPConnector(
        resolver=LanOnlyResolver(address_map),
        # Home Assistant's own context: FULL verification against the name in the URL. Connecting
        # by IP without this would relax exactly what API_CONTRACT.md §0 says never to relax.
        ssl=client_context(),
    )
    return aiohttp.ClientSession(connector=connector)


def is_address(value: str | None) -> bool:
    """True for a literal IPv4/IPv6 address."""
    if not value:
        return False
    try:
        ip_address(value)
    except ValueError:
        return False
    return True


async def is_this_doorbell(
    session: aiohttp.ClientSession, address: str, device_id: str
) -> bool:
    """`GET http://<ip>/api/device_id` answers with THIS doorbell's id.

    §0 defines this route for exactly this: first contact, no credentials, read-only, no side
    effect. The id must MATCH — an address recycled by DHCP may have another device, even another
    doorbell, behind it.
    """
    if not is_address(address):
        return False
    try:
        async with session.get(
            f"http://{address}/api/device_id",
            # Short on purpose: a doorbell on the same network answers in tens of milliseconds, and
            # a black-hole address would otherwise eat the entry's whole setup budget.
            timeout=aiohttp.ClientTimeout(total=3),
        ) as resp:
            if resp.status != 200:
                return False
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError):
        return False
    return isinstance(data, dict) and data.get("device_id") == device_id
