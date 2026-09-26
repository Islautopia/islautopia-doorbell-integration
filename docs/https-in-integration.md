# HTTPS inside the integration (replacing the "Islautopia HTTPS for Home Assistant" app)

Status: proof of concept, 2026-09-26. Branch `poc-https`, not merged. PoC code in
`tools/poc_https/` (not wired into the integration).

## Verdict

**Yes.** Everything the app does can run inside the integration, on Home Assistant's
own event loop, with no new secret on the device and **no `configuration.yaml`
edit**. It also works where the app cannot exist (HA Container / Core).

The recommended shape is not a proxy at all: an **extra TLS listener that feeds
connections straight into HA's own aiohttp runner** ("mode A" below). It was measured
end to end in a scratch HA 2026.9.0 container: real password login, WebSocket,
`isSecureContext === true`, `getUserMedia` granted, HA sees the real client address.

One piece was *not* measured: the listener running inside Iñaki's HA OS install
(needs installing code + a restart). See "Open".

## What the app does today (read from `origin/main`, app 0.9.0)

- Caddy on `:8443`, two site blocks chosen by SNI: `<id>.ha.doorbell.islautopia.com`
  gets the Let's Encrypt certificate; anything else (bare IP = no SNI,
  `homeassistant.local`) gets a leaf from a private CA. Plain-HTTP trust portal on `:8099`.
- Private CA (RSA 2048, 10 y, `pathlen:0`, **no name constraints**) and leaf (398 d)
  generated with `openssl`; stored in `/ssl/islautopia_ha_https/ca/`.
  (DOCS.md still says "the app's private storage": outdated.)
- **Public certificate**: the device does no ACME. It calls our VPS:
  1. `POST /ha_instance/register {"device_id": <IG Doorbell id>}` once → `ha_instance_id` + `ha_secret`
     (the doorbell id is a *quota* gate, not authentication).
  2. `POST /ha_instance/<id>/report_ip` (Bearer `ha_secret`) → VPS upserts an A record in Route53.
  3. `GET /ha_instance/<id>/cert` (Bearer) → VPS runs `acme.sh --dns dns_aws` (DNS-01, Route53,
     IAM credentials only on the VPS) and returns **cert + private key** as JSON. Rechecked every 12 h.
- Caddy's `reverse_proxy` adds `X-Forwarded-For`; the app does nothing about HA's
  reverse-proxy check and its docs don't mention it (see point 3).

## Evidence

### 1. Public certificate from Python — no new secrets
The flow above is three HTTPS calls with a bearer token minted by our VPS; ACME and the
DNS credentials stay on the VPS. `ig_https.fetch_public_cert()` does it with aiohttp.
Measured against the live VPS (negative controls only — a positive one would need
a real identity, and registering a new one spends Let's Encrypt quota):
`GET /ha_instance/0000000000000000/cert` → `404 unknown_ha_instance`;
`POST /ha_instance/register {}` → `400 device_id_required`.
Bonus: the integration already knows the doorbell id from its config entry, so the
user no longer types it into an app option.

### 2. TLS + SNI + HA through it (standalone on a PC → Iñaki's HA 2026.9.0, read-only)
`tools/poc_https/standalone.py` (mode B proxy, aiohttp, SNI via `SSLContext.sni_callback`).
A second unrelated CA stood in for Let's Encrypt (what is tested is SNI selection).

Handshakes (`checks/tls_check.py`), verifying against each CA:

| case | result |
|---|---|
| bare IP (no SNI sent) vs local CA | OK, local leaf |
| SNI `homeassistant.local` vs local CA | OK, local leaf |
| SNI public name vs "public" CA | OK, public leaf |
| SNI `wrong.example.com` | local leaf (catch-all) |
| NEG public name vs local CA | FAIL (chain) |
| NEG bare IP vs public CA | FAIL (chain) |
| NEG unknown name + hostname check | FAIL (hostname mismatch) |

Chrome (installed Chrome via Playwright, fake mic; the local CA trusted through
`--ignore-certificate-errors-spki-list`, standing in for "root installed on the device";
login by injecting the long-lived token into `hassTokens`):

| URL | isSecureContext | getUserMedia | HA frontend + WS |
|---|---|---|---|
| NEG `http://<ha-ip>:8123` | false | `mediaDevices` undefined | loads, WS up, 3302 states |
| `https://<pc-ip>:8443` (proxy, local cert) | **true** | **granted, 1 track** | loads, WS up, 3302 states |
| `https://<public-name>:8443` (proxy, SNI) | **true** | **granted** | loads, WS up |
| NEG same, root not trusted | — | — | `ERR_CERT_AUTHORITY_INVALID` |

Event loop: run with `loop.set_debug(True)`, `slow_callback_duration = 50 ms`:
**0 slow callbacks** across all of the above.

### 2b. Inside Home Assistant (scratch HA 2026.9.0 in Docker, NOT Iñaki's)
`tools/poc_https/custom_components/ig_https_poc/` starts, after `EVENT_HOMEASSISTANT_STARTED`:
mode A on 8443, mode B (proxy, no XFF) on 8444, mode B' (proxy **with** XFF, like Caddy) on 8445.
Real password login in Chrome through each:

| mode | first response | login + WS | isSecureContext / mic | HA sees client as |
|---|---|---|---|---|
| NEG plain http | 200 | OK | false / undefined | 172.17.0.1 |
| **A: listener on `hass.http.runner`** | 200 | **OK** | **true / granted** | **172.17.0.1 (real)** |
| B: proxy, no XFF | 200 | OK | true / granted | 127.0.0.1 |
| B': proxy with XFF | **400** | fails | — | HA logs "not set-up for reverse proxies" |

HA's blocking-call detector: **positive control** (a deliberate `open()` in the loop)
was reported ("Detected blocking call to open ... by custom integration"); the PoC code
itself produced no other report.

### 3. HA's reverse-proxy protection
- HA answers **400** to any request carrying `X-Forwarded-For` unless
  `use_x_forwarded_for` and a matching `trusted_proxies` are set (`http/forwarded.py`).
- Measured on Iñaki's HA: direct request with XFF from the PC → 400; through the app → 200.
  So his `configuration.yaml` trusts the app's network. On a fresh HA (B' above) the same
  Caddy behaviour gives **400 on every request**: the app as shipped needs a
  configuration edit its docs never ask for. **(Worth checking independently of this PoC.)**
- In-process, **mode A avoids the question entirely**: no forwarded header exists, the
  peer is the real client. Mode B also avoids the 400 (by not sending XFF) but HA then
  sees every client as 127.0.0.1, and that is a real problem, measured: 3 failed logins
  through B banned `127.0.0.1` → **everyone using the HTTPS address locked out (403)**
  while `:8123` kept working. The same test through A banned the real client IP, exactly
  like `:8123` does.

### 4. Binding ports
- HA OS: Supervisor runs the core container with `network_mode="host"`
  (`supervisor/docker/homeassistant.py`), so a listener in the integration binds the
  host's 8443/8099 directly. `/ssl` is mounted **read-only** in core (same file), so the
  integration keeps its files under `/config`.
- HA Container: the official install docs use `--network=host` / `network_mode: host`.
  With bridge networking the user must publish the ports (document it; detect nothing).
- No HA or HACS rule forbids an integration from listening; core integrations do it
  (HomeKit, emulated_hue, Sonos event listener). HACS requirements are repo-shape only.
- `hass.http.runner` is **not public API**. HA 2026.9.0 serves its own `:8123` with
  exactly this pattern (`loop.create_server` with the runner's protocol factory,
  `http/server.py`); 2024.1 used a `TCPSite` on the same runner. The attribute is
  present in the 2024.1.0, 2025.1.0 and 2026.9.0 sources. Mitigation: if it is missing, fall back to
  mode B and raise a repair issue — never silently.

## Architecture (proposed)

```
integration setup (after EVENT_HOMEASSISTANT_STARTED)
 ├─ LocalCA (executor): /config/.storage/ig_doorbell_https/ca/*   (adopt /ssl/islautopia_ha_https if present)
 ├─ leaf SANs from homeassistant.components.network adapters      (works on Container/Core; no Supervisor API)
 ├─ public cert: register (device_id from config entry) / report_ip / GET cert, every 12 h
 ├─ SniContexts: listen ctx + sni_callback → public ctx | local ctx; hot-swap, no re-bind
 ├─ :8443  loop.create_server(hass.http.runner.server, ssl=listen ctx)       (mode A)
 └─ :8099  aiohttp portal (plain HTTP): CA + fingerprint; fingerprint also in a repair/notification
```
Port conflicts (`EADDRINUSE`, e.g. the app still running) → repair issue, never a crash.
Unload closes the server.

### Hard requirements (Iñaki, 2026-09-26)

- **Port configurable** in the options flow, default 8443. If it is taken: a clear
  repair issue naming the port and the likely holder; nothing else stops working.
- **Coexistence with every other HTTPS path to the same HA**: the user's own reverse
  proxy in front of `:8123` (with `use_x_forwarded_for`/`trusted_proxies`), Nabu Casa,
  HA's own `ssl_certificate`. **Nothing we do may alter HA's `http:` settings.** Mode A
  meets this by construction: it adds a listener and touches neither `:8123`, the
  middleware chain, nor the configuration. Baseline on Iñaki's HA before the in-HA
  test: `:8123` 200; XFF from an untrusted address 400; through his own proxy
  (trusted) 200. The same three must hold with the integration running.

### 1.1.0: the VPS must not hold the HA's private key

Confirmed in `ig_doorbell_vps/opt/rendezvous/register_api.py`: today `issue_cert()`
runs `acme.sh --issue ... --keylength ec-256`, so **the VPS generates the key**, keeps
it at `/root/.acme.sh/<host>_ecc/<host>.key`, and `GET /ha_instance/<id>/cert` returns
it in the JSON response every 12 h. For 1.1.0: the integration generates its key
locally and sends only a CSR; the VPS runs `acme.sh --signcsr --csr <file> --dns dns_aws`
(DNS-01 is unchanged) and returns only the certificate. The key then never leaves the
HA. Renewals re-send the stored CSR (or a new one with a rotated key).

## Measured vs assumed

Measured: all tables above. **Assumed / not measured**: running in a real HA OS
install; hot-swap of certificates without dropping open WebSockets (the design allows
it; not exercised); iOS/Android/companion-app behaviour (only desktop Chrome);
a real Let's Encrypt cert served by this code (the VPS path is identical to the app's,
but no identity was used); Chrome's real interstitial "Proceed" (Playwright's
`ignore_https_errors` also gave a secure context — not the same thing, do not rely on it).

## Risks

- **CA private key in `/config`.** Anyone who reads it can mint certificates that every
  device which installed the root will trust — and today's root has **no name
  constraints**, so that means *any* site, not just this HA. `/config` is readable by
  every custom integration (same process), by file-sharing apps (Samba, SSH, File editor,
  Studio Code), and is inside HA backups (encrypted only if backups are encrypted).
  Honest comparison: the app's key in `/ssl` is reachable by the same file-sharing apps
  and is also backed up, so moving it is a small change in exposure, not a new class.
  **Recommendation**: new roots get X.509 *name constraints* (private IP ranges,
  `homeassistant.local`, `localhost`), making a leaked key useless against other sites.
  Existing roots can't be changed without re-installing on every device.
- Public cert private key is generated on our VPS (unchanged from the app).
- Private-API dependency on `hass.http.runner` (see 4).
- TLS handshakes run on HA's loop (as HA's own SSL does). EC P-256 keys keep it cheap.

## Migration from the app

1. Integration reads `/ssl/islautopia_ha_https/{ha_instance.json,ca/}` (read-only mount)
   and copies them to `/config/.storage/...` → same public hostname, same root already
   trusted by devices; nobody re-installs anything.
2. If `:8443` is taken (app still running) → repair issue "stop and uninstall the app".
3. Users who added `trusted_proxies` for the app can remove it (harmless if left).
4. App: final version that only tells users to move; later retired.

## Effort

~3–4 days code (module, options flow switch, repairs, translations, tests with a
fake runner), 1–2 days validation on HA OS + Container + phones, plus the VPS
unchanged. ~1 week total.

## Open

- In-HA test on HA OS: deploy `ig_https_poc` (or a flagged build of the integration) to
  Iñaki's HA with the app stopped, restart, re-run `checks/` against `https://<ha-ip>:8443`.
- Name constraints on new roots: accept? (changes nothing for existing devices).
- On by default, or opt-in in the options flow?
