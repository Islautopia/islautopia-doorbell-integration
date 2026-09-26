"""Standalone run of the PoC proxy (mode B) on a PC, in front of a real HA.

usage: python standalone.py <scratch_dir> <upstream_url> <lan_ip>
Certificates and keys are written ONLY under <scratch_dir>.
Runs the loop in debug mode and counts callbacks slower than 50 ms, as
evidence that nothing blocks the event loop.
"""
import asyncio
import json
import logging
import sys
from pathlib import Path

import aiohttp
from aiohttp import web

import ig_https

PUBLIC_TEST_NAME = "poctest.ha.doorbell.islautopia.com"


class SlowCounter(logging.Handler):
    def __init__(self):
        super().__init__()
        self.slow = []

    def emit(self, record):
        if "Executing" in record.getMessage() and "took" in record.getMessage():
            self.slow.append(record.getMessage()[:200])


async def main(scratch: Path, upstream: str, lan_ip: str) -> None:
    loop = asyncio.get_running_loop()
    loop.set_debug(True)
    loop.slow_callback_duration = 0.05
    counter = SlowCounter()
    logging.getLogger("asyncio").addHandler(counter)

    ca = ig_https.LocalCA(scratch / "local_ca")
    await loop.run_in_executor(None, ca.ensure_ca)
    leaf = await loop.run_in_executor(
        None, ca.issue_leaf, ["homeassistant.local", "localhost"], [lan_ip, "127.0.0.1"])
    # Stand-in for the Let's Encrypt certificate: a second, unrelated CA. What is
    # measured here is the SNI selection, not Let's Encrypt.
    fake_pub = ig_https.LocalCA(scratch / "fake_public_ca")
    await loop.run_in_executor(None, fake_pub.ensure_ca)
    pub = await loop.run_in_executor(None, fake_pub.issue_leaf, [PUBLIC_TEST_NAME], [])

    sni = ig_https.SniContexts()
    await loop.run_in_executor(None, sni.load_local, leaf)
    await loop.run_in_executor(None, sni.load_public, PUBLIC_TEST_NAME, pub.chain, pub.key)

    proxy = ig_https.make_proxy_app(
        upstream.rstrip("/"),
        lambda: aiohttp.ClientSession(auto_decompress=False,
                                      connector=aiohttp.TCPConnector(limit=100)))
    runner = web.AppRunner(proxy)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", 8443, ssl_context=sni.listen).start()

    ca_pem = await loop.run_in_executor(None, ca.ca_cert.read_bytes)
    fp = await loop.run_in_executor(None, ca.fingerprint)
    portal = web.AppRunner(ig_https.make_portal_app(ca_pem, fp))
    await portal.setup()
    await web.TCPSite(portal, "0.0.0.0", 8099).start()

    status = scratch / "status.json"
    print("listening 8443 (TLS, SNI) and 8099 (portal); CA", fp, flush=True)
    while True:
        await asyncio.sleep(2)
        data = {"slow_callbacks": len(counter.slow), "slow_samples": counter.slow[:5],
                "sni_picks": sni.picks}
        await loop.run_in_executor(None, status.write_text, json.dumps(data, indent=1))


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main(Path(sys.argv[1]), sys.argv[2], sys.argv[3]))
