"""Phase 0 rule 1: the integration reaches the doorbell at its LAN address and NOTHING else.

The resolver has no DNS inside. These tests make that observable: a name it does not know raises
and no system resolver is consulted, and a name it knows goes to the stored IP.
"""
from __future__ import annotations

import socket
from unittest.mock import patch

import aiohttp
import pytest

from custom_components.ig_doorbell import const, net

from .conftest import DEVICE_ID, LAN_IP

HOST = f"{DEVICE_ID}.{const.DOORBELL_HOSTNAME_SUFFIX}"


class _Chivato:
    """Counts every call into the system resolver (both paths aiohttp could take)."""

    def __init__(self):
        self.llamadas = []

    def getaddrinfo(self, *a, **k):
        self.llamadas.append(a[0] if a else k.get("host"))
        raise AssertionError("system DNS consulted")


async def test_known_name_goes_to_the_lan_ip_without_dns():
    chivato = _Chivato()
    with patch.object(socket, "getaddrinfo", chivato.getaddrinfo):
        r = net.LanOnlyResolver({HOST: LAN_IP})
        res = await r.resolve(HOST, 8443)
    assert [x["host"] for x in res] == [LAN_IP]
    assert chivato.llamadas == []


async def test_unknown_name_raises_and_never_asks_dns():
    """The old resolver fell back to public DNS here. Now: an error, and zero DNS queries."""
    chivato = _Chivato()
    with patch.object(socket, "getaddrinfo", chivato.getaddrinfo), \
         patch.object(aiohttp.ThreadedResolver, "resolve", side_effect=AssertionError("DNS")):
        r = net.LanOnlyResolver({HOST: LAN_IP})
        with pytest.raises(OSError):
            await r.resolve("relay.doorbell.islautopia.com", 443)
        with pytest.raises(OSError):
            await r.resolve(f"otro.{const.DOORBELL_HOSTNAME_SUFFIX}", 8443)
    assert chivato.llamadas == []


def test_a_name_can_never_be_stored_as_the_address():
    with pytest.raises(ValueError):
        net.LanOnlyResolver({HOST: HOST})


def test_no_relay_or_turn_left_in_the_code():
    """Nothing in the package may point at the relay or fetch TURN credentials (plan §1.3 #1-#4)."""
    import pathlib

    raiz = pathlib.Path(net.__file__).parent
    texto = "\n".join(
        p.read_text(encoding="utf-8") for p in raiz.glob("*.py")
    )
    assert not hasattr(const, "RELAY_HOST")
    for prohibido in ("relay.doorbell", "app_turn_credentials", "get_turn_credentials",
                      "async_get_clientsession("):
        # docstrings may TELL the story; code may not do it. Only non-comment code lines count.
        lineas = [
            l for l in texto.splitlines()
            if prohibido in l and not l.strip().startswith(("#", '"', "'", "-", "`"))
            and "NOT `async_get_clientsession" not in l
        ]
        assert lineas == [], (prohibido, lineas)
