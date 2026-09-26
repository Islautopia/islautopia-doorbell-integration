// Manual check (not part of the permanent bench) that the side rail is chosen by the
// CONTENT'S REAL GEOMETRY (not by whether there's software rotation), after the bug measured on
// Iñaki's real Galaxy Tab on 2026-09-08: with the stream already in portrait from the sensor (_rot=0, no
// rotation), `vertical = (_rot===90||270)` came out false and the rail wasn't even evaluated -- a bottom band
// covering the image in both normal mode AND fullscreen, exactly where the empty black bars were biggest.
//
// Loads the REAL dist/ file via the existing doubled-network harness
// (test/idle_release_network/harness.js) just to have tCreateCard/tAttach and a fake hass --
// none of the card's logic is replaced.
const { chromium } = require('playwright-core');
const path = require('path');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8794/tests/card/_manual_overlay_check/index.html';
const OUTDIR = process.env.OUT_DIR || 'C:\\Users\\inaki\\AppData\\Local\\Temp\\claude\\c--Proyectos-espressif-IG-Doorbell\\d628b33a-426b-4168-adc6-51a203bb47b4\\scratchpad';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function rectsIntersect(a, b) {
  const noOverlap = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  return !noOverlap;
}

// IMPORTANT NOTE (found by measuring, not foreseen while writing this): both .actions-row and
// .hud-bottom are declared with `left:0(or 14px);right:0(or 14px)` -- they're FULL-WIDTH flex
// containers on purpose, with pointer-events:none on the container itself and :auto only on
// the real children. Comparing getBoundingClientRect() of those TWO containers against each other ALWAYS gives an
// intersection the moment they share a vertical band, no matter what happens horizontally -- it doesn't measure a
// real overlap. The check that DOES mean something is against the visible children: the
// circular buttons (.action) on one side and the real controls cluster (.hud-bottom-right) on the other.
async function measure(page, id) {
  return page.evaluate((id) => {
    const card = window.__cards[id];
    const content = card.content;
    const feedWrap = card.feedWrap;
    const actionsRow = card.querySelector('.actions-row');
    const hudBottom = card.querySelector('.hud-bottom');
    const hudBottomRight = card.querySelector('.hud-bottom-right');
    const statusLine = card.statusLine;
    const actions = Array.from(card.querySelectorAll('.actions-row .action'));
    const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
    const actionRects = actions.map(r);
    const actionsUnion = actionRects.reduce((u, b) => u ? {
      left: Math.min(u.left, b.left), right: Math.max(u.right, b.right),
      top: Math.min(u.top, b.top), bottom: Math.max(u.bottom, b.bottom),
    } : b, null);
    return {
      isRail: content.classList.contains('ig-rail'),
      rot: card._rot,
      videoWidth: card.videoEl.videoWidth,
      videoHeight: card.videoEl.videoHeight,
      feedWrap: r(feedWrap),
      actionsUnion,
      hudBottomRight: r(hudBottomRight),
      statusLine: r(statusLine),
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  }, id);
}

function within(outer, inner, tol) {
  return inner.left >= outer.left - tol && inner.right <= outer.right + tol
    && inner.top >= outer.top - tol && inner.bottom <= outer.bottom + tol;
}

// REAL video (canvas -> captureStream() -> setupRemoteStream()), with whatever RAW dimensions
// are requested -- now that the rail genuinely depends on videoWidth/videoHeight, the
// <video> needs real metadata, not a hand-painted color. It waits for 'loadedmetadata' before
// measuring: it's exactly the event the fix added so it wouldn't get stuck in band mode forever.
async function feedRealVideo(page, id, { rawW, rawH, label, color }) {
  await page.evaluate(({ id, rawW, rawH, label, color }) => {
    const card = window.__cards[id];
    card._setLiveState('live');
    card.feedWrap.dataset.state = 'live';
    card.micButton.removeAttribute('disabled');
    if (card.unlockButton) card.unlockButton.removeAttribute('disabled');
    if (card.loader) { card.loader.style.opacity = '0'; card.loader.style.pointerEvents = 'none'; }
    const canvas = document.createElement('canvas');
    canvas.width = rawW; canvas.height = rawH;
    const ctx = canvas.getContext('2d');
    function draw() {
      ctx.fillStyle = color; ctx.fillRect(0, 0, rawW, rawH);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(4, rawW * 0.01);
      ctx.strokeRect(4, 4, rawW - 8, rawH - 8);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(rawW * 0.07)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(label, rawW / 2, rawH / 2);
      requestAnimationFrame(draw);
    }
    draw();
    const stream = canvas.captureStream(10);
    card.setupRemoteStream(stream);
  }, { id, rawW, rawH, label, color });
  await page.waitForFunction((id) => {
    const v = window.__cards[id].videoEl;
    return v.videoWidth > 0 && v.videoHeight > 0;
  }, id, { timeout: 5000 });
}

async function newPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  return page;
}

async function runScenario(browser, { name, viewport, rot, rawW, rawH, label, color, forceFs, screenshotName }) {
  console.log(`\n========== ${name} (viewport ${viewport.width}x${viewport.height}, rot=${rot}, raw=${rawW}x${rawH}${forceFs ? ', forced FULLSCREEN' : ''}) ==========`);
  const page = await newPage(browser, viewport);
  const id = name.replace(/[^a-z0-9]/gi, '_');
  await page.evaluate((id) => { window.tCreateCard(id, {}); window.tAttach(id); }, id);
  await sleep(150);
  await page.evaluate(({ id, rot }) => { window.__cards[id]._applyRotation(rot); }, { id, rot });
  await feedRealVideo(page, id, { rawW, rawH, label, color });
  await sleep(150); // lets the ResizeObserver/loadedmetadata settle

  if (forceFs) {
    // Level 2 (our own fallback, position:fixed) without going through the real Fullscreen API -- it
    // doesn't fire without a user gesture in an automated test. _applyFullscreenUI() is the SAME
    // function the real path uses to paint the UI (classes, the data-fs attribute, and it itself
    // calls _layoutRotation()).
    await page.evaluate((id) => {
      const card = window.__cards[id];
      card._fsNative = false;
      card._fsActive = true;
      card._applyFullscreenUI();
    }, id);
    await sleep(150);
  }

  const m = await measure(page, id);
  console.log('isRail =', m.isRail, ' rot =', m.rot, ' videoWidth/Height =', m.videoWidth, 'x', m.videoHeight);
  console.log('feedWrap       =', JSON.stringify(m.feedWrap));
  console.log('actionsUnion   =', JSON.stringify(m.actionsUnion));
  console.log('hudBottomRight =', JSON.stringify(m.hudBottomRight));
  console.log('statusLine     =', JSON.stringify(m.statusLine));

  const containedActions = within(m.feedWrap, m.actionsUnion, 1);
  const containedStatus = within(m.feedWrap, m.statusLine, 1);
  const overlapReal = rectsIntersect(m.actionsUnion, m.hudBottomRight);
  const noVScroll = forceFs ? true : (m.docScrollHeight <= m.innerHeight + 1); // in forced fullscreen the body-lock changes the test page's layout, that's not what's measured here

  console.log(`buttons inside feed-wrap: ${containedActions}`);
  console.log(`status-line inside feed-wrap: ${containedStatus}`);
  console.log(`REAL OVERLAP (buttons vs the HUD's visible cluster): ${overlapReal} (must be false)`);
  if (!forceFs) console.log(`no vertical scroll (docScrollHeight=${m.docScrollHeight} <= innerHeight=${m.innerHeight}): ${noVScroll}`);

  const outPath = path.join(OUTDIR, screenshotName);
  await page.screenshot({ path: outPath, fullPage: false });
  console.log('screenshot ->', outPath);

  await page.close();
  return { name, m, containedActions, containedStatus, overlapReal, noVScroll };
}

async function positiveControl(browser) {
  console.log('\n========== POSITIVE CONTROL: force the overlap on purpose ==========');
  const page = await newPage(browser, { width: 1920, height: 1200 });
  const id = 'ctrlpos';
  await page.evaluate((id) => { window.tCreateCard(id, {}); window.tAttach(id); }, id);
  await sleep(150);
  await page.evaluate((id) => { window.__cards[id]._applyRotation(0); }, id);
  await feedRealVideo(page, id, { rawW: 720, rawH: 1280, label: 'CTRL', color: '#333333' });
  await sleep(150);

  const before = await measure(page, id);
  const overlapBefore = rectsIntersect(before.actionsUnion, before.hudBottomRight);
  console.log('before forcing anything, (real) overlap detected =', overlapBefore, '(must be false)');

  await page.evaluate((id) => {
    const card = window.__cards[id];
    const hudBottomRight = card.querySelector('.hud-bottom-right');
    const micBtn = card.querySelector('#mic-button');
    const r = micBtn.getBoundingClientRect();
    hudBottomRight.style.setProperty('position', 'fixed', 'important');
    hudBottomRight.style.setProperty('left', r.left + 'px', 'important');
    hudBottomRight.style.setProperty('top', r.top + 'px', 'important');
    hudBottomRight.style.setProperty('right', 'auto', 'important');
    hudBottomRight.style.setProperty('bottom', 'auto', 'important');
    hudBottomRight.style.setProperty('margin', '0', 'important');
    hudBottomRight.style.setProperty('z-index', '999', 'important');
  }, id);
  await sleep(50);
  const after = await measure(page, id);
  const overlapAfter = rectsIntersect(after.actionsUnion, after.hudBottomRight);
  console.log('after forcing the overlap, (real) overlap detected =', overlapAfter, '(must be true)');

  const verdict = (overlapBefore === false && overlapAfter === true)
    ? 'POSITIVE CONTROL OK: the check tells overlap apart from no-overlap'
    : 'INVALID CONTROL: the check cannot tell them apart -- do not trust the rest of the results';
  console.log('=>', verdict);
  await page.close();
  return { overlapBefore, overlapAfter, verdict };
}

// ================================================================================================
// HYSTERESIS TEST (Iñaki, 2026-09-08): measures what the hysteresis exists to prevent, not just
// that the code implements it. Fixes content (720x1280) and frame HEIGHT (866px, the same as the
// real wallpanel) via inline style directly on feedWrap -- so WIDTH is the only
// variable, and the "leftover on each side" (what decides the rail) is an exact linear function of
// that width: leftover = (w - 720*(866/1280)) / 2 = (w - 487.03) / 2.
//
// Thresholds: RAIL_WIDTH=104 (leave/stay), RAIL_ENTER_MARGIN=136 (enter). Widths chosen so
// the leftover falls cleanly in each zone:
//   w=650 -> leftover= 81.5  (< 104, safe band)
//   w=720 -> leftover=116.5  (between 104 and 136, DEAD ZONE -- this is where a single threshold oscillates)
//   w=800 -> leftover=156.5  (> 136, safe rail)
async function hysteresisTest(browser) {
  console.log('\n========== HYSTERESIS TEST: crossing the threshold up and down, and jitter in the dead zone ==========');
  const page = await newPage(browser, { width: 1920, height: 1200 });
  const id = 'hyst';
  await page.evaluate((id) => { window.tCreateCard(id, {}); window.tAttach(id); }, id);
  await sleep(150);
  await page.evaluate((id) => { window.__cards[id]._applyRotation(0); }, id);
  await feedRealVideo(page, id, { rawW: 720, rawH: 1280, label: 'HYST', color: '#455A64' });
  await sleep(150);

  async function setWidthAndRead(w) {
    return page.evaluate(({ id, w }) => {
      const card = window.__cards[id];
      card.feedWrap.style.height = '866px';
      card.feedWrap.style.width = `${w}px`;
      card._layoutRotation();
      return { w, isRail: card.content.classList.contains('ig-rail'), railActive: card._railActive };
    }, { id, w });
  }

  const sequence = [650, 720, 800, 720, 650];
  const expected = [false, false, true, true, false];
  const labels = ['safe band', 'dead zone (1st time, coming from band)', 'safe rail', 'dead zone (2nd time, coming from rail)', 'safe band'];
  let sequenceOk = true;
  for (let i = 0; i < sequence.length; i++) {
    const r = await setWidthAndRead(sequence[i]);
    const ok = r.isRail === expected[i];
    if (!ok) sequenceOk = false;
    console.log(`  w=${sequence[i]}px (${labels[i]}): isRail=${r.isRail}  expected=${expected[i]}  ${ok ? 'OK' : 'FAIL'}`);
  }
  console.log(`=> Directional sequence (the same 720 width gives different results depending on how it's reached): ${sequenceOk ? 'OK -- hysteresis confirmed' : 'FAIL'}`);

  // Jitter INSIDE the dead zone (leftover between 104 and 136, w between ~695 and ~759), starting
  // from RAIL (after the w=800 above) - if there were flicker, some toggle would show up here.
  console.log('  -- jitter in the dead zone starting from RAIL (10 random widths, w between 700-755) --');
  let railChanges = 0;
  let prevState = (await setWidthAndRead(800)).isRail; // makes sure it starts from rail
  for (let i = 0; i < 10; i++) {
    const w = 700 + Math.floor(Math.random() * 55); // 700..754 -> leftover ~106.5..133.5, inside (104,136)
    const r = await setWidthAndRead(w);
    if (r.isRail !== prevState) railChanges++;
    prevState = r.isRail;
  }
  console.log(`  state changes during the jitter starting from rail: ${railChanges} (must be 0)`);

  console.log('  -- jitter in the dead zone starting from BAND (10 random widths, w between 700-755) --');
  let bandChanges = 0;
  prevState = (await setWidthAndRead(650)).isRail; // makes sure it starts from band
  for (let i = 0; i < 10; i++) {
    const w = 700 + Math.floor(Math.random() * 55);
    const r = await setWidthAndRead(w);
    if (r.isRail !== prevState) bandChanges++;
    prevState = r.isRail;
  }
  console.log(`  state changes during the jitter starting from band: ${bandChanges} (must be 0)`);

  const verdict = (sequenceOk && railChanges === 0 && bandChanges === 0)
    ? 'HYSTERESIS OK: no flicker in the dead zone, and the same width gives different results depending on history'
    : 'HYSTERESIS FAILED: there is flicker, or the directional sequence did not come out as expected';
  console.log('=>', verdict);
  await page.close();
  return { sequenceOk, railChanges, bandChanges, verdict };
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  const ctrl = await positiveControl(browser);
  const hyst = await hysteresisTest(browser);
  const results = [];

  // ============ 2x2 MATRIX, ALL WITH _rot=0 (NO software rotation) ============
  // This is Iñaki's real case: the sensor already delivers portrait, nothing to rotate with CSS.

  results.push(await runScenario(browser, {
    name: '1_landscape_tablet_portrait_video_NO_ROTATION (THE CASE THAT WAS FAILING)',
    viewport: { width: 1920, height: 1200 }, rot: 0, rawW: 720, rawH: 1280,
    label: 'VERTICAL rot=0', color: '#1565C0',
    screenshotName: 'v2_1_tablet_landscape_video_vertical_rot0.png',
  }));
  results.push(await runScenario(browser, {
    name: '2_landscape_tablet_landscape_video',
    viewport: { width: 1920, height: 1200 }, rot: 0, rawW: 1280, rawH: 720,
    label: 'LANDSCAPE', color: '#2e7d32',
    screenshotName: 'v2_2_tablet_landscape_video_landscape.png',
  }));
  results.push(await runScenario(browser, {
    name: '3_portrait_phone_portrait_video_NO_ROTATION (EDGE CASE: must not give a rail)',
    viewport: { width: 400, height: 850 }, rot: 0, rawW: 720, rawH: 1280,
    label: 'VERTICAL rot=0', color: '#1565C0',
    screenshotName: 'v2_3_movil_vertical_rot0.png',
  }));
  results.push(await runScenario(browser, {
    name: '4_portrait_tablet_portrait_video_NO_ROTATION',
    viewport: { width: 900, height: 1600 }, rot: 0, rawW: 720, rawH: 1280,
    label: 'VERTICAL rot=0', color: '#1565C0',
    screenshotName: 'v2_4_tablet_vertical_video_vertical_rot0.png',
  }));

  // ============ REGRESSION: the case that ALREADY worked (with software rotation) ============
  results.push(await runScenario(browser, {
    name: '5_REGRESSION_landscape_tablet_portrait_video_WITH_90_ROTATION',
    viewport: { width: 1920, height: 1200 }, rot: 90, rawW: 1280, rawH: 720,
    label: 'VERTICAL rot=90', color: '#6A1B9A',
    screenshotName: 'v2_5_regresion_rot90.png',
  }));

  // ============ FULLSCREEN with the case that used to fail (where Iñaki saw it worst) ============
  results.push(await runScenario(browser, {
    name: '6_FULLSCREEN_portrait_video_NO_ROTATION',
    viewport: { width: 1920, height: 1200 }, rot: 0, rawW: 720, rawH: 1280,
    label: 'VERTICAL rot=0 FS', color: '#1565C0', forceFs: true,
    screenshotName: 'v2_6_fullscreen_video_vertical_rot0.png',
  }));

  console.log('\n\n================ SUMMARY ================');
  console.log('positive control:', ctrl.verdict);
  console.log('hysteresis:', hyst.verdict);
  for (const r of results) {
    console.log(`${r.name}: isRail=${r.m.isRail} contained_actions=${r.containedActions} contained_status=${r.containedStatus} no_overlap_real=${!r.overlapReal} no_vscroll=${r.noVScroll}`);
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
