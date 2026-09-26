import asyncio, json, sys
from playwright.async_api import async_playwright
from browser_check import spki, PROBE, HA_STATE
PW = open("scratch_ha_pw.txt").read().strip()
REFRESH_IPS = """async () => { const h = document.querySelector('home-assistant').hass;
  const toks = await h.callWS({type:'auth/refresh_tokens'});
  return toks.filter(t => t.is_current).map(t => t.last_used_ip); }"""
async def case(p, label, url, spkis):
    b = await p.chromium.launch(channel="chrome", args=["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",
        "--host-resolver-rules=MAP homeassistant.local 192.168.41.125",
        "--ignore-certificate-errors-spki-list=" + ",".join(spkis)])
    page = await (await b.new_context()).new_page()
    out = {"case": label}
    try:
        r = await page.goto(url + "/", wait_until="domcontentloaded", timeout=20000)
        out["first_status"] = r.status
        await page.locator("input[name=username]").fill("poc", timeout=15000)
        await page.locator("input[name=password]").fill(PW)
        await page.locator("input[name=password]").press("Enter")
        for _ in range(60):
            try:
                st = await page.evaluate(HA_STATE)
                if st.get("ws_connected"): break
            except Exception: pass
            await asyncio.sleep(0.5)
        out["ha"] = st
        out.update(await page.evaluate(PROBE))
        out["ha_sees_client_ip"] = await page.evaluate(REFRESH_IPS)
    except Exception as e:
        out["error"] = str(e).splitlines()[0][:200]
    await b.close(); print(json.dumps(out), flush=True)
async def main():
    spkis = [spki(sys.argv[1])]
    async with async_playwright() as p:
        for label, url in json.loads(sys.argv[2]):
            await case(p, label, url, spkis)
asyncio.run(main())
