// REAL Chromium review of the v1.9.5 changes (Iñaki, 2026-09-25 afternoon): "REC and the
// bell must look the same [as in the apps]", "the modes should also be a dropdown
// chip" and the new Recordings button (same admin criterion as REC, no Settings).
// Loads the real dist/ig-doorbell-card.js; harness.js (a literal copy of test/ui_v1_9_2's)
// only doubles the network layer, same criterion as the rest of this directory's harnesses.
//
// RUN:
//   1. From the worktree root: python -m http.server 8795
//   2. node test/ui_v1_9_5/driver.js
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8795/tests/card/ui_v1_9_5/index.html';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

async function newPage(browser) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('TESTLOG')) console.log(t.replace(/^TESTLOG /, ''));
    else if (msg.type() === 'error') console.log('[console.error] ' + t);
  });
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness listo')));
  return page;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await newPage(browser);

  console.log('\n########## 1. REC: capsula en la cabecera, "REC" fijo (no traducido), no en .actions-row ##########');
  await page.evaluate(() => {
    window.tSetAdmin(false); // same as the "Kiosko" tablet: the HA user isn't an admin
    window.tSetRole('admin'); // but the integration IS the doorbell's administrator
    window.tSetHassState('switch.rec_test', 'off', {});
    window.tCreateCard('a', { rec_entity: 'switch.rec_test' });
    window.tAttach('a');
    window.tRefreshHass('a');
  });
  await sleep(150);
  let recInfo = await page.evaluate(() => {
    const c = window.__cards['a'];
    return {
      inTopRow: !!c.querySelector('#top-row #rec-button'),
      inActionsRow: !!c.querySelector('.actions-row #rec-button'),
      label: c.recLabel ? c.recLabel.textContent : null,
      recording: c.recButton.classList.contains('recording'),
    };
  });
  check('#rec-button vive en la cabecera (#top-row)', recInfo.inTopRow === true);
  check('#rec-button ya NO vive en .actions-row', recInfo.inActionsRow === false);
  check('la etiqueta es "REC" fija, universal como en las apps (no "Grabar"/"Grabando")', recInfo.label === 'REC');
  check('sin grabar: clase "recording" ausente', recInfo.recording === false);

  await page.evaluate(() => { window.tSetHassState('switch.rec_test', 'on', {}); window.tRefreshHass('a'); });
  await sleep(50);
  let recOn = await page.evaluate(() => {
    const c = window.__cards['a'];
    return { recording: c.recButton.classList.contains('recording'), label: c.recLabel.textContent };
  });
  check('grabando: clase "recording" presente (rojo, via CSS)', recOn.recording === true);
  check('la etiqueta sigue siendo "REC" fija tambien grabando', recOn.label === 'REC');

  console.log('\n########## 2. Modo: chip desplegable (no fila de 4 chips) ##########');
  await page.evaluate(() => {
    window.tSetHassState('select.modo_test', 'away', { options: ['normal', 'away', 'do_not_disturb', 'custom'] });
    window.tCreateCard('b', { mode_entity: 'select.modo_test' });
    window.tAttach('b');
    window.tRefreshHass('b');
  });
  await sleep(150);
  let modeShape = await page.evaluate(() => {
    const c = window.__cards['b'];
    return {
      pillCount: c.querySelectorAll('#mode-row .mode-pill').length,
      chipCount: c.querySelectorAll('#mode-row .chip').length, // the old row must no longer exist
      menuClosedAtStart: c.querySelector('#mode-menu').style.display === 'none',
      pillText: c.querySelector('.mode-pill-label').textContent,
    };
  });
  check('hay exactamente UN chip desplegable (no una fila de chips)', modeShape.pillCount === 1);
  check('la fila vieja de chips segmentados ya no existe', modeShape.chipCount === 0);
  check('el desplegable arranca cerrado', modeShape.menuClosedAtStart === true);
  check('el chip enseña la etiqueta del modo VIGENTE sin desplegar nada ("away")', modeShape.pillText === 'away');

  await page.evaluate(() => window.tClick('b', '#mode-pill'));
  await sleep(30);
  let menuOpen = await page.evaluate(() => window.__cards['b'].querySelector('#mode-menu').style.display !== 'none');
  check('un click en el chip abre el desplegable', menuOpen === true);

  // A click outside (on <body>, outside the card) closes it -- same criterion as the rest of this
  // card's menus (fullscreen/quality).
  await page.evaluate(() => document.body.click());
  await sleep(30);
  let menuClosedAfterOutsideClick = await page.evaluate(() => window.__cards['b'].querySelector('#mode-menu').style.display === 'none');
  check('un click fuera cierra el desplegable', menuClosedAfterOutsideClick === true);

  console.log('\n########## 3. Grabaciones: mismo gating que REC (rol del portero, no hass.user.is_admin), sin Ajustes ##########');
  await page.evaluate(() => {
    window.tSetAdmin(false);
    window.tSetRole('user'); // the doorbell did NOT pair this integration as its administrator
    window.tCreateCard('c', {});
    window.tAttach('c');
    window.tRefreshHass('c');
  });
  await sleep(150);
  // v1.9.8: the row (`recordingsAction`/#bottom-row) is NO LONGER entirely hidden for a regular user -- now
  // it shares a spot with "Quick Replies", which IS visible for any role (see
  // _updateQuickReplyButton() in dist/). What still gates by role is specifically the Recordings
  // BUTTON (`recordingsButton`), not the row that contains it.
  let recNoAdmin = await page.evaluate(() => window.__cards['c'].recordingsButton.style.display);
  check('el boton de Grabaciones se oculta para un emparejamiento no-admin del portero', recNoAdmin === 'none');
  let noSettingsButton = await page.evaluate(() => !window.__cards['c'].querySelector('#settings-button, .quick-btn[data-target="settings"]'));
  check('no existe ningun boton de Ajustes en la card (vive en la integracion)', noSettingsButton === true);

  await page.evaluate(() => { window.tSetRole('admin'); window.tCreateCard('d', {}); window.tAttach('d'); window.tRefreshHass('d'); });
  await sleep(150);
  let recAdmin = await page.evaluate(() => {
    const c = window.__cards['d'];
    return { display: c.recordingsAction.style.display, label: c.querySelector('.quick-btn-label').textContent };
  });
  check('visible con emparejamiento admin del portero', recAdmin.display !== 'none');
  check('la etiqueta es "Grabaciones" (es-ES por defecto del arnes)', recAdmin.label === 'Grabaciones');

  console.log('\n########## 4. Grabaciones: navega al media_source de ESTE portero sin reproductor propio ##########');
  const beforePath = await page.evaluate(() => location.pathname);
  await page.evaluate(() => window.tClick('d', '#recordings-button'));
  await sleep(30);
  const afterPath = await page.evaluate(() => decodeURIComponent(location.pathname));
  check('la URL cambio (navegacion SPA, sin recarga)', afterPath !== beforePath);
  check(
    'la URL apunta al media-browser nativo, sin entidad media_player, con el media_content_id de ESTE portero',
    afterPath === '/media-browser/browser/video,media-source://ig_doorbell/test-device-d',
  );

  await browser.close();
  console.log(`\n${fails === 0 ? 'TODO OK' : `${fails} FALLO(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
