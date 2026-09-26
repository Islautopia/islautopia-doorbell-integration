"""Scratch-only PoC: the HTTPS listener running INSIDE Home Assistant.

Mode A (port 8443): extra TLS listener on HA's own aiohttp runner.
Mode B (port 8444): in-process reverse proxy to 127.0.0.1:<http port>, no XFF.
Mode B' (port 8445): same proxy but WITH X-Forwarded-For, i.e. what Caddy in the
add-on does -- control for the trusted_proxies question.
Portal on 8099. Never install this on a real Home Assistant.
"""
from __future__ import annotations

import logging
from pathlib import Path

import aiohttp
from aiohttp import web

from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant

from . import ig_https

_LOGGER = logging.getLogger(__name__)
DOMAIN = "ig_https_poc"


async def async_setup(hass: HomeAssistant, config) -> bool:
    conf = config.get(DOMAIN) or {}

    async def _start(_event=None) -> None:
        if conf.get("blocking_control"):
            # POSITIVE CONTROL for HA's blocking-call detector: a deliberate
            # blocking open() in the event loop. Must produce a
            # "Detected blocking call" log line, or the detector proves nothing.
            open(hass.config.path("blocking_control.txt"), "w").close()

        ca = ig_https.LocalCA(Path(hass.config.path(DOMAIN)))
        await hass.async_add_executor_job(ca.ensure_ca)
        leaf = await hass.async_add_executor_job(
            ca.issue_leaf, ["homeassistant.local", "localhost"], ["127.0.0.1"])
        sni = ig_https.SniContexts()
        await hass.async_add_executor_job(sni.load_local, leaf)

        srv = await ig_https.start_direct_listener(hass, "0.0.0.0", 8443, sni.listen)
        _LOGGER.warning("PoC mode A listening on 8443 via hass.http.runner")

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

        runners = []
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
        _LOGGER.warning("PoC proxies on 8444 (no XFF) / 8445 (XFF), portal 8099, CA %s", fp)

        async def _stop(_e):
            srv.close()
            for rr in runners:
                await rr.cleanup()
        hass.bus.async_listen_once("homeassistant_stop", _stop)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _start)
    return True
