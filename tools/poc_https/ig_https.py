"""Proof of concept: HTTPS for Home Assistant from inside an integration.

Everything here is written the way an integration has to run it: on Home
Assistant's asyncio loop, with every blocking step (key generation, file I/O,
loading certificates into an SSLContext) pushed to an executor.

Pieces:
  * LocalCA            -- private CA + leaf for LAN IPs / homeassistant.local
  * SniContexts        -- one listening SSLContext that picks the certificate
                          per connection from the SNI (public name -> public
                          cert, anything else or no SNI -> local cert), and can
                          swap certificates without re-binding the port
  * start_direct_listener -- an extra TLS listener that feeds connections
                          straight into Home Assistant's own aiohttp runner
                          (what HA itself does for its Supervisor socket and
                          legacy-port redirect). No proxy, no forwarded headers.
  * make_proxy_app     -- fallback: a transparent HTTP + WebSocket reverse proxy
                          to 8123 that deliberately sends NO X-Forwarded-For.
  * make_portal_app    -- the plain-HTTP trust portal (CA download).
  * fetch_public_cert  -- the VPS call the add-on makes (GET /ha_instance/<id>/cert).

PoC only. Not wired into the integration.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import ipaddress
import logging
import os
import ssl
import tempfile
from dataclasses import dataclass
from pathlib import Path

import aiohttp
from aiohttp import web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

_LOGGER = logging.getLogger(__name__)

API_BASE = "https://relay.doorbell.islautopia.com"
DOMAIN_SUFFIX = "ha.doorbell.islautopia.com"


# --------------------------------------------------------------------------- CA
@dataclass
class LeafFiles:
    chain: Path
    key: Path


class LocalCA:
    """Private CA stored in `directory`. All methods are blocking: run them in
    an executor (hass.async_add_executor_job)."""

    CA_DAYS = 3650
    LEAF_DAYS = 398

    def __init__(self, directory: Path) -> None:
        self.dir = Path(directory)
        self.ca_cert = self.dir / "ca.crt"
        self.ca_key = self.dir / "ca.key"
        self.leaf = LeafFiles(self.dir / "local-fullchain.crt", self.dir / "local.key")

    def ensure_ca(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        if self.ca_cert.exists() and self.ca_key.exists():
            return
        key = ec.generate_private_key(ec.SECP256R1())
        suffix = hashlib.sha256(
            key.public_key().public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        ).hexdigest()[:8]
        name = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, f"Islautopia Home Assistant Local CA {suffix}"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Islautopia"),
        ])
        now = dt.datetime.now(dt.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=self.CA_DAYS))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256())
        )
        _write_private(self.ca_key, key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()))
        self.ca_cert.write_bytes(cert.public_bytes(serialization.Encoding.PEM))

    def issue_leaf(self, dns_names: list[str], ips: list[str]) -> LeafFiles:
        ca_key = serialization.load_pem_private_key(self.ca_key.read_bytes(), None)
        ca_cert = x509.load_pem_x509_certificate(self.ca_cert.read_bytes())
        key = ec.generate_private_key(ec.SECP256R1())
        now = dt.datetime.now(dt.timezone.utc)
        san = [x509.DNSName(n) for n in dns_names] + [
            x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
        cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, (ips or dns_names)[0])]))
            .issuer_name(ca_cert.subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - dt.timedelta(minutes=5))
            .not_valid_after(now + dt.timedelta(days=self.LEAF_DAYS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        _write_private(self.leaf.key, key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()))
        self.leaf.chain.write_bytes(
            cert.public_bytes(serialization.Encoding.PEM) + self.ca_cert.read_bytes())
        return self.leaf

    def fingerprint(self) -> str:
        c = x509.load_pem_x509_certificate(self.ca_cert.read_bytes())
        return c.fingerprint(hashes.SHA256()).hex(":").upper()


def _write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


# -------------------------------------------------------------------- SNI / TLS
def _server_context(chain: Path, key: Path) -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.set_alpn_protocols(["http/1.1"])
    ctx.load_cert_chain(chain, key)  # blocking (file I/O): executor only
    return ctx


class SniContexts:
    """The listening context is `self.listen`. Its sni_callback hands each
    connection the context for the name it asked for. Certificates are swapped
    by replacing the per-name contexts -- the port is never re-bound, so a
    renewal does not drop open WebSockets (the add-on restarts Caddy instead)."""

    def __init__(self) -> None:
        self.local: ssl.SSLContext | None = None
        self.public: ssl.SSLContext | None = None
        self.public_name: str | None = None
        self.listen = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.listen.minimum_version = ssl.TLSVersion.TLSv1_2
        self.listen.set_alpn_protocols(["http/1.1"])
        self.listen.sni_callback = self._pick
        self.picks: dict[str, int] = {}

    def load_local(self, leaf: LeafFiles) -> None:  # blocking
        self.local = _server_context(leaf.chain, leaf.key)
        # The no-SNI case (bare IP) is served by the listening context itself,
        # so it carries the local certificate too.
        self.listen.load_cert_chain(leaf.chain, leaf.key)

    def load_public(self, name: str, chain: Path, key: Path) -> None:  # blocking
        self.public = _server_context(chain, key)
        self.public_name = name.lower()

    def _pick(self, sslobj: ssl.SSLObject, name: str | None, _ctx) -> None:
        if name and self.public is not None and name.lower() == self.public_name:
            sslobj.context = self.public
            which = "public"
        else:
            if self.local is not None:
                sslobj.context = self.local
            which = "local"
        key = f"{name}->{which}"
        self.picks[key] = self.picks.get(key, 0) + 1
        return None


# ------------------------------------------------- mode A: HA's own runner
async def start_direct_listener(hass, host: str, port: int, ctx: ssl.SSLContext) -> asyncio.Server:
    """Serve HA's own aiohttp app on an extra TLS port.

    Same pattern HA core uses for its legacy-port redirect / Supervisor socket:
    loop.create_server(runner.server, ...). Requests reach HA's middlewares with
    the REAL client address as peername and no X-Forwarded-For, so
    use_x_forwarded_for / trusted_proxies never come into play and ip_ban sees
    the real client. Uses hass.http.runner, which is not public API (present
    from 2024.1.0 to 2026.9.0 at least)."""
    runner = hass.http.runner
    if runner is None or runner.server is None:
        raise RuntimeError("HA HTTP runner not started yet (wait for EVENT_HOMEASSISTANT_STARTED)")
    return await hass.loop.create_server(runner.server, host, port, ssl=ctx, backlog=128)


# ------------------------------------------------- mode B: reverse proxy
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
       "trailer", "transfer-encoding", "upgrade", "host", "content-length"}


def make_proxy_app(upstream: str, session_factory) -> web.Application:
    """Transparent HTTP + WebSocket proxy to `upstream` (e.g. http://127.0.0.1:8123).

    Deliberately does NOT add X-Forwarded-For: HA answers 400 to any request
    carrying it unless configuration.yaml has use_x_forwarded_for + a matching
    trusted_proxies. The price: HA sees the proxy's address as the client."""
    app = web.Application(client_max_size=1024 ** 3)
    state = {"session": None}

    async def _session() -> aiohttp.ClientSession:
        if state["session"] is None:
            state["session"] = session_factory()
        return state["session"]

    async def handler(request: web.Request) -> web.StreamResponse:
        sess = await _session()
        url = upstream + request.rel_url.path_qs
        headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP}
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return await _ws(request, sess, url, headers)
        async with sess.request(request.method, url, headers=headers,
                                data=request.content if request.body_exists else None,
                                allow_redirects=False) as up:
            resp = web.StreamResponse(status=up.status, reason=up.reason)
            for k, v in up.headers.items():
                if k.lower() not in HOP and k.lower() != "content-encoding":
                    resp.headers.add(k, v)
            if "Content-Encoding" in up.headers:
                resp.headers["Content-Encoding"] = up.headers["Content-Encoding"]
            await resp.prepare(request)
            async for chunk in up.content.iter_chunked(64 * 1024):
                await resp.write(chunk)
            await resp.write_eof()
            return resp

    async def _ws(request, sess, url, headers):
        protos = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if p.strip()]
        down = web.WebSocketResponse(protocols=protos, autoping=True, max_msg_size=0)
        await down.prepare(request)
        fwd = {k: v for k, v in headers.items() if not k.lower().startswith("sec-websocket")}
        async with sess.ws_connect(url.replace("http", "ws", 1), headers=fwd,
                                   protocols=protos, max_msg_size=0) as upws:
            async def pump(src, dst):
                async for msg in src:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await dst.send_str(msg.data)
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        await dst.send_bytes(msg.data)
                    else:
                        break
                await dst.close()
            await asyncio.gather(pump(down, upws), pump(upws, down), return_exceptions=True)
        return down

    async def _close(_app):
        if state["session"] is not None:
            await state["session"].close()

    app.router.add_route("*", "/{tail:.*}", handler)
    app.on_cleanup.append(_close)
    return app


# ------------------------------------------------- trust portal (plain HTTP)
def make_portal_app(ca_cert_pem: bytes, fingerprint: str) -> web.Application:
    app = web.Application()

    async def ca(_r):
        return web.Response(body=ca_cert_pem, content_type="application/x-x509-ca-cert",
                            headers={"Content-Disposition": "attachment; filename=islautopia-ha-ca.crt"})

    async def index(_r):
        return web.Response(text=f"<!doctype html><title>Trust</title><p>Fingerprint "
                                 f"<code>{fingerprint}</code></p><a href='ca.crt' download>CA</a>",
                            content_type="text/html")

    app.router.add_get("/ca.crt", ca)
    app.router.add_get("/{tail:.*}", index)
    return app


# ------------------------------------------------- public certificate (VPS)
async def fetch_public_cert(session: aiohttp.ClientSession, instance_id: str, secret: str) -> dict:
    """Exactly the add-on's call: the VPS runs acme.sh DNS-01 against Route53
    and returns cert + key. The device holds no DNS/ACME credential, only its
    own ha_secret."""
    async with session.get(f"{API_BASE}/ha_instance/{instance_id}/cert",
                           headers={"Authorization": f"Bearer {secret}"},
                           timeout=aiohttp.ClientTimeout(total=120)) as r:
        body = await r.json(content_type=None)
        return {"status": r.status, **(body if isinstance(body, dict) else {})}
