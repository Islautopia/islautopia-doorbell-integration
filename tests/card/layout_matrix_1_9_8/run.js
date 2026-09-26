// Layout matrix for ig-doorbell-card against a REAL Home Assistant.
// Usage (from the repo root):  HASS_URL=... HASS_TOKEN=... node test/layout_matrix_1_9_8/run.js <setup|capture|teardown|all> [filter]
// See README.md in this folder. Never pass a production doorbell: TARGET_TITLE selects the config entry.
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const HASS_URL = (process.env.HASS_URL || '').replace(/\/$/, '');
const HASS_TOKEN = process.env.HASS_TOKEN || '';
const TARGET_TITLE = process.env.TARGET_TITLE || 'Waveshare';
const URL_PATH = 'igd-card-layout-test';
const CHROME = process.env.CHROME || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const OUT = __dirname;
if (!HASS_URL || !HASS_TOKEN) { console.error('HASS_URL / HASS_TOKEN missing'); process.exit(2); }

const SIZES = {
  phone_port: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone_land: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet_port: { viewport: { width: 800, height: 1280 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true },
  tablet_land: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true },
  pc: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
const VIEWS = ['sections', 'masonry', 'sidebar', 'sidebarside', 'panel', 'panelcap'];

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(HASS_URL + '/manifest.json'); // same origin, no frontend redirect racing us
  await page.evaluate(([url, tok]) => {
    localStorage.setItem('hassTokens', JSON.stringify({
      access_token: tok, token_type: 'Bearer', expires_in: 1e9, hassUrl: url,
      clientId: url + '/', expires: Date.now() + 1e12, refresh_token: '',
    }));
    localStorage.setItem('selectedLanguage', '"es"');
  }, [HASS_URL, HASS_TOKEN]);
  return page;
}

async function hassReady(page) {
  await page.waitForFunction(() => { const h = document.querySelector('home-assistant'); return h && h.hass && h.hass.connected; }, null, { timeout: 30000 });
}
const ws = (page, msg) => page.evaluate((m) => document.querySelector('home-assistant').hass.callWS(m), msg);

async function setup(page) {
  const entries = await ws(page, { type: 'config_entries/get', domain: 'ig_doorbell' }).catch(() => null);
  const entry = (entries || []).find((e) => e.title === TARGET_TITLE);
  if (!entry) throw new Error(`config entry "${TARGET_TITLE}" not found`);
  const devs = await ws(page, { type: 'config/device_registry/list' });
  const dev = devs.find((d) => (d.config_entries || []).includes(entry.entry_id) &&
    (d.identifiers || []).some((i) => i[0] === 'ig_doorbell'));
  if (!dev) throw new Error('device not found');
  const deviceId = dev.identifiers.find((i) => i[0] === 'ig_doorbell')[1];
  if (/ermita/i.test(dev.name || '') || /ermita/i.test(entry.title)) throw new Error('refusing: production doorbell');
  const card = { type: 'custom:ig-doorbell-card', device_id: deviceId };
  const md = { type: 'markdown', content: 'Filler card (layout test)' };
  const config = {
    title: 'IGD card layout test (temporary)',
    views: [
      { title: 'Sections', path: 'sections', type: 'sections', max_columns: 4, sections: [{ type: 'grid', cards: [card] }] },
      { title: 'Masonry', path: 'masonry', cards: [card] },
      { title: 'Sidebar', path: 'sidebar', type: 'sidebar', cards: [card, { ...md, view_layout: { position: 'sidebar' } }] },
      { title: 'Sidebar side', path: 'sidebarside', type: 'sidebar', cards: [md, { ...card, view_layout: { position: 'sidebar' } }] },
      { title: 'Panel', path: 'panel', type: 'panel', cards: [card] },
      // Same panel with a `height:` cap, the other way the stack layout gets chosen on a wide screen.
      { title: 'Panel cap', path: 'panelcap', type: 'panel', cards: [{ ...card, height: '600px' }] },
    ],
  };
  const list = await ws(page, { type: 'lovelace/dashboards/list' });
  if (!list.some((d) => d.url_path === URL_PATH)) {
    await ws(page, { type: 'lovelace/dashboards/create', url_path: URL_PATH, title: 'IGD card layout test (temporary)', mode: 'storage', require_admin: false, show_in_sidebar: false });
  }
  await ws(page, { type: 'lovelace/config/save', url_path: URL_PATH, config });
  console.log('setup ok, entry', entry.title, 'device name', dev.name);
}

async function teardown(page) {
  const list = await ws(page, { type: 'lovelace/dashboards/list' });
  const d = list.find((x) => x.url_path === URL_PATH);
  if (d) await ws(page, { type: 'lovelace/dashboards/delete', dashboard_id: d.id });
  const after = await ws(page, { type: 'lovelace/dashboards/list' });
  console.log('teardown: dashboard present after delete =', after.some((x) => x.url_path === URL_PATH));
}

// Finds the card through shadow roots and reports geometry.
const MEASURE = () => {
  const find = (root) => {
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (n.tagName && n.tagName.toLowerCase() === 'ig-doorbell-card') return n;
      if (n.shadowRoot) q.push(n.shadowRoot);
      for (const c of (n.children || [])) q.push(c);
    }
    return null;
  };
  const card = find(document);
  if (!card) return { error: 'no card' };
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const v = card.videoEl;
  const fw = card.feedWrap;
  let img = null;
  if (v && fw && v.videoWidth) {
    const c = card._contentSize();
    const f = fw.getBoundingClientRect();
    const s = Math.min(f.width / c.w, f.height / c.h);
    img = { w: Math.round(c.w * s), h: Math.round(c.h * s), usedPct: Math.round(100 * (c.w * s * c.h * s) / (f.width * f.height)) };
  }
  const btns = [...card.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => ({ cls: b.className, ...r(b) }));
  return {
    rot: card._rot, raw: v ? [v.videoWidth, v.videoHeight] : null, t: v ? v.currentTime : 0,
    classes: card.content ? card.content.className : '', card: r(card), feed: r(fw), img,
    actions: r(card.actionsRow), actionsParent: card.actionsRow && card.actionsRow.parentElement && card.actionsRow.parentElement.className,
    actionsTransform: card.actionsRow && getComputedStyle(card.actionsRow).transform,
    btns, vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth,
    docH: document.documentElement.scrollHeight,
    avail: card._availableHeight ? Math.round(card._availableHeight()) : null,
  };
};

async function capture(browser, filter) {
  const results = {};
  const resFile = path.join(OUT, 'metrics.json');
  if (fs.existsSync(resFile)) Object.assign(results, JSON.parse(fs.readFileSync(resFile, 'utf8')));
  for (const [sizeName, opts] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ ...opts, locale: 'es-ES', ignoreHTTPSErrors: true });
    const lp = await login(ctx); await lp.close();
    for (const view of VIEWS) {
      // Variants: 'portrait' = simulated 9:16 (product default mounting), 'landscape' = simulated
      // 16:9, 'native' = whatever the bench streams (Waveshare: 1080x1200, rot 0).
      let orients = ['portrait'];
      if (view === 'panel' && (sizeName === 'pc' || sizeName === 'tablet_land')) orients = ['portrait', 'landscape', 'native'];
      if (view === 'panelcap') orients = sizeName === 'pc' ? ['portrait'] : [];
      for (const o of orients) {
        const name = `${view}_${sizeName}_${o}`;
        if (filter && !name.includes(filter)) continue;
        const page = await ctx.newPage();
        try {
          await page.goto(`${HASS_URL}/${URL_PATH}/${view}`, { waitUntil: 'domcontentloaded' });
          await hassReady(page);
          await page.waitForFunction(`(${MEASURE.toString()})().t > 1.5`, null, { timeout: 45000 });
          let m;
          if (o !== 'native') {
            // Page-side override, doorbell untouched: the card's layout decisions all go through
            // _contentSize(); the real frame is stretched (object-fit:fill) and clipped to the rect
            // a real 9:16 / 16:9 stream would occupy, so the picture is distorted but the geometry exact.
            const sim = o === 'portrait' ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
            const apply = (s) => {
              const find = (root) => { const q = [root]; while (q.length) { const n = q.shift(); if (n.tagName && n.tagName.toLowerCase() === 'ig-doorbell-card') return n; if (n.shadowRoot) q.push(n.shadowRoot); for (const c of (n.children || [])) q.push(c); } return null; };
              const card = find(document);
              if (!card.__sim) {
                card.__sim = true; card._rot = 0; card._rotConfirmed = true;
                card._applyRotation = () => {};
                card._contentSize = () => ({ w: s.w, h: s.h });
                if (card.feedWrap) card.feedWrap.setAttribute('data-rot', '0');
              }
              card._fitToSpace(); card._layoutRotation();
              const v = card.videoEl; const fw = card.feedWrap.clientWidth; const fh = card.feedWrap.clientHeight;
              const k = Math.min(fw / s.w, fh / s.h); const iw = s.w * k; const ih = s.h * k;
              v.style.objectFit = 'fill';
              v.style.clipPath = `inset(${(fh - ih) / 2}px ${(fw - iw) / 2}px)`;
            };
            await page.evaluate(apply, sim);
            await page.waitForTimeout(600);
            await page.evaluate(apply, sim);
          }
          await page.waitForTimeout(1200);
          m = await page.evaluate(MEASURE);
          const file = `${view}_${sizeName}_${o}.png`;
          await page.screenshot({ path: path.join(OUT, file) });
          results[file] = m;
          console.log(file, JSON.stringify({ cls: m.classes, feed: m.feed, img: m.img, actions: m.actions, tr: m.actionsTransform, scrollW: m.scrollW, vw: m.vw }));
        } catch (e) {
          console.log(name, 'ERROR', e.message.split('\n')[0]);
          await page.screenshot({ path: path.join(OUT, `${name}_ERROR.png`) }).catch(() => {});
        } finally {
          await page.close();
          await new Promise((res) => setTimeout(res, 1500)); // let the doorbell free the video slot
        }
      }
    }
    await ctx.close();
  }
  fs.writeFileSync(resFile, JSON.stringify(results, null, 1));
}

(async () => {
  const mode = process.argv[2] || 'all';
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await login(ctx);
    await page.goto(HASS_URL + '/', { waitUntil: 'domcontentloaded' });
    await hassReady(page);
    if (mode === 'setup' || mode === 'all') await setup(page);
    if (mode === 'capture' || mode === 'all') await capture(browser, process.argv[3]);
    if (mode === 'teardown' || mode === 'all') await teardown(page);
    await ctx.close();
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
