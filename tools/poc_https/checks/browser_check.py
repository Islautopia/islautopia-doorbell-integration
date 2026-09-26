"""Chromium checks: secure context, getUserMedia, HA frontend + websocket.
argv: <leaf1.pem,leaf2.pem> <json list of cases>  ; token read in-process only."""
import asyncio, base64, hashlib, json, sys
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from playwright.async_api import async_playwright
import secrets_env

def spki(pem_path):
    c = x509.load_pem_x509_certificates(open(pem_path,'rb').read())[0]
    der = c.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return base64.b64encode(hashlib.sha256(der).digest()).decode()

PROBE = """async () => {
  const r = {isSecureContext: window.isSecureContext, mediaDevices: typeof navigator.mediaDevices};
  try { const s = await navigator.mediaDevices.getUserMedia({audio:true});
        r.getUserMedia = 'granted, audio tracks=' + s.getAudioTracks().length; s.getTracks().forEach(t=>t.stop()); }
  catch(e) { r.getUserMedia = 'error: ' + (e && (e.name||e.message) || e); }
  return r; }"""

HA_STATE = """() => { const ha = document.querySelector('home-assistant');
  const h = ha && ha.hass; if (!h) return {hass:false};
  return {hass:true, ws_connected: !!(h.connection && h.connection.connected),
          states: Object.keys(h.states||{}).length, user: h.user && h.user.is_admin !== undefined,
          ha_version: h.config && h.config.version}; }"""

async def run_case(p, case, spkis, token):
    args = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
            "--host-resolver-rules=MAP poctest.ha.doorbell.islautopia.com 192.168.41.125"]
    if case.get("trust"):
        args.append("--ignore-certificate-errors-spki-list=" + ",".join(spkis))
    b = await p.chromium.launch(channel="chrome", args=args)
    ctx = await b.new_context(ignore_https_errors=case.get("clickthrough", False))
    page = await ctx.new_page()
    out = {"case": case["label"]}
    try:
        origin = case["url"].rstrip("/")
        if case.get("login"):
            await page.goto(origin + "/manifest.json")
            await page.evaluate("""([o,t]) => localStorage.setItem('hassTokens', JSON.stringify({
                access_token:t, token_type:'Bearer', expires_in:1800, hassUrl:o, clientId:o+'/',
                expires: Date.now()+1e10, refresh_token:''}))""", [origin, token])
        resp = await page.goto(origin + "/", wait_until="domcontentloaded", timeout=20000)
        out["http_status"] = resp.status if resp else None
        out.update(await page.evaluate(PROBE))
        if case.get("login"):
            for _ in range(40):
                st = await page.evaluate(HA_STATE)
                if st.get("ws_connected") and st.get("states"): break
                await asyncio.sleep(0.5)
            out["ha"] = st
    except Exception as e:
        out["error"] = str(e).splitlines()[0][:160]
    await b.close()
    return out

async def main():
    spkis = [spki(x) for x in sys.argv[1].split(",")]
    cases = json.loads(sys.argv[2])
    token = secrets_env.load()["HASS_TOKEN"]
    async with async_playwright() as p:
        for c in cases:
            print(json.dumps(await run_case(p, c, spkis, token)))
if __name__ == "__main__": asyncio.run(main())
