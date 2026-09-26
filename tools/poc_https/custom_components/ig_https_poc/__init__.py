"""PoC: the HTTPS listener running INSIDE Home Assistant.

Default (`ig_https_poc:` with no options), what runs on a real HA:
  * mode A on 8443: extra TLS listener on HA's own aiohttp runner
  * trust portal on 8099 (plain HTTP)
  * local leaf for every IPv4 of every enabled network adapter + homeassistant.local
  * public certificate: if the app's identity exists in /ssl/islautopia_ha_https
    (read-only mount), fetch the ALREADY ISSUED cert from the VPS with it
    (GET /ha_instance/<id>/cert: returns the existing cert, spends no quota)
Options (scratch HA only):
  proxies: true          -> mode B (8444, no XFF) and B' (8445, with XFF)
  blocking_control: true -> deliberate blocking open() (positive control)

Everything is written under /config/ig_https_poc. Remove that folder on rollback.
To test, copy ../../ig_https.py next to this file (not duplicated in git).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import aiohttp
from aiohttp import web

from homeassistant.components import network
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import ig_https

_LOGGER = logging.getLogger(__name__)
DOMAIN = "ig_https_poc"
APP_IDENTITY = Path("/ssl/islautopia_ha_https/ha_instance.json")


def _read_identity() -> dict | None:
    try:
        return json.loads(APP_IDENTITY.read_text())
    except (OSError, ValueError):
        return None


def _save_public(d: Path, cert: str, key: str) -> tuple[Path, Path]:
    d.mkdir(parents=True, exist_ok=True)
    c, k = d / "fullchain.pem", d / "privkey.pem"
    c.write_text(cert)
    ig_https._write_private(k, key.encode())
    return c, k


async def async_setup(hass: HomeAssistant, config) -> bool:
    conf = config.get(DOMAIN) or {}
    base = Path(hass.config.path(DOMAIN))

    async def _start(_event=None) -> None:
        t0 = time.monotonic()
        if conf.get("blocking_control"):
            open(hass.config.path("blocking_control.txt"), "w").close()

        ips = ["127.0.0.1"]
        for adapter in await network.async_get_adapters(hass):
            if adapter["enabled"]:
                ips += [a["address"] for a in adapter["ipv4"]]
        ips = list(dict.fromkeys(ips))

        ca = ig_https.LocalCA(base / "local_ca")
        await hass.async_add_executor_job(ca.ensure_ca)
        leaf = await hass.async_add_executor_job(
            ca.issue_leaf, ["homeassistant.local", "localhost"], ips)
        sni = ig_https.SniContexts()
        await hass.async_add_executor_job(sni.load_local, leaf)

        ident = await hass.async_add_executor_job(_read_identity)
        public_name = None
        if ident and ident.get("ha_instance_id") and ident.get("ha_secret"):
            try:
                res = await ig_https.fetch_public_cert(
                    async_get_clientsession(hass), ident["ha_instance_id"], ident["ha_secret"])
                if res.get("status") == 200:
                    c, k = await hass.async_add_executor_job(
                        _save_public, base / "public", res["cert"], res["key"])
                    public_name = res["hostname"]
                    await hass.async_add_executor_job(sni.load_public, public_name, c, k)
                else:
                    _LOGGER.warning("PoC public cert: VPS answered %s", res.get("status"))
            except Exception as err:  # PoC: report and continue on the local path
                _LOGGER.warning("PoC public cert unavailable: %s", err)

        srv = await ig_https.start_direct_listener(hass, "0.0.0.0", 8443, sni.listen)
        runners = []
        port = hass.http.server_port

        def proxy(xff: bool):
            app = ig_https.make_proxy_app(
                f"http://127.0.0.1:{port}",
                lambda: aiohttp.ClientSession(auto_decompress=False))
            if xff:
                @web.middleware
                async def add_xff(request, handler):
                    peer = request.transport.get_extra_info("peername")[0]
                    request = request.clone(headers={**request.headers, "X-Forwarded-For": peer})
                    return await handler(request)
                app.middlewares.append(add_xff)
            return app

        if conf.get("proxies"):
            for p, xff in ((8444, False), (8445, True)):
                r = web.AppRunner(proxy(xff))
                await r.setup()
                await web.TCPSite(r, "0.0.0.0", p, ssl_context=sni.listen).start()
                runners.append(r)

        pem = await hass.async_add_executor_job(ca.ca_cert.read_bytes)
        fp = await hass.async_add_executor_job(ca.fingerprint)
        r = web.AppRunner(ig_https.make_portal_app(pem, fp))
        await r.setup()
        await web.TCPSite(r, "0.0.0.0", 8099).start()
        runners.append(r)
        _LOGGER.warning(
            "PoC up in %.2f s: mode A on 8443 via hass.http.runner, portal 8099; "
            "local SANs %s; public name %s; CA %s",
            time.monotonic() - t0, ips, public_name, fp)

        async def _stop(_e):
            srv.close()
            for rr in runners:
                await rr.cleanup()
        hass.bus.async_listen_once("homeassistant_stop", _stop)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start)
    return True
