// REAL Chromium review of the v1.9.2 changes (Iñaki, 2026-09-25): REC against the integration's
// entity, the street speaker moved to the button row (no volume slider), the quality selector
// and clock retired, and the native-fullscreen safety class. Loads the real
// dist/ig-doorbell-card.js; harness.js only doubles the network layer (same
// criterion as test/idle_release_network).
//
// ⚠️ Tests 4 and 7 were updated in v1.9.5 (same afternoon): the mode chip went from a row of 4
// chips to a dropdown chip, and REC moved from `.actions-row` to the header (`#top-row`) to
// look like the apps - see test/ui_v1_9_5/driver.js for the dedicated checks for that
// change.
//
// RUN:
//   1. From the worktree root: python -m http.server 8793
//   2. node test/ui_v1_9_2/driver.js
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8793/tests/card/ui_v1_9_2/index.html';

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

  console.log('\n########## 1. Sin rec_entity: el boton de REC no existe visible ##########');
  await page.evaluate(() => { window.tCreateCard('a', {}); window.tAttach('a'); });
  await sleep(150);
  let recDisplay = await page.evaluate(() => document.getElementById('host').querySelector('ig-doorbell-view').recAction.style.display);
  check('rec-action display:none sin rec_entity configurada', recDisplay === 'none');

  console.log('\n########## 2. Con rec_entity + integracion admin del portero: aparece y hace toggle ##########');
  await page.evaluate(() => {
    // The user of THIS HA panel isn't an administrator -- exactly the real case of the
    // "Kiosko" tablet (Iñaki, 2026-09-25) -- and REC must still show, because what governs it is the role
    // the DOORBELL gave the integration (`get_connection_info.role`), not `hass.user.is_admin`.
    window.tSetAdmin(false);
    window.tSetRole('admin');
    window.tSetHassState('switch.rec_test', 'off', {});
    window.tCreateCard('b', { rec_entity: 'switch.rec_test' });
    window.tAttach('b');
    window.tRefreshHass('b');
  });
  await sleep(150);
  let st = await page.evaluate(() => {
    const c = window.__cards['b'];
    return { display: c.recAction.style.display, recording: c.recButton.classList.contains('recording') };
  });
  check('rec-action visible (rol admin del portero + entidad presente, aunque el usuario de HA no sea admin)', st.display !== 'none');
  check('boton NO marcado como grabando (estado off)', st.recording === false);

  await page.evaluate(() => window.tClick('b', '#rec-button'));
  await sleep(50);
  let calls = await page.evaluate(() => window.__calledServices.slice());
  check('el primer toque pide turn_on (estaba off)', calls.some((c) => c.domain === 'switch' && c.service === 'turn_on' && c.data.entity_id === 'switch.rec_test'));

  await page.evaluate(() => { window.tSetHassState('switch.rec_test', 'on', {}); window.tRefreshHass('b'); });
  await sleep(50);
  let st2 = await page.evaluate(() => {
    const c = window.__cards['b'];
    return c.recButton.classList.contains('recording');
  });
  check('boton pasa a "grabando" en cuanto la ENTIDAD (no el ultimo tap) dice on', st2 === true);

  await page.evaluate(() => { window.__calledServices.length = 0; window.tClick('b', '#rec-button'); });
  await sleep(50);
  calls = await page.evaluate(() => window.__calledServices.slice());
  check('con la entidad en "on", el toque pide turn_off (nunca el ultimo tap)', calls.some((c) => c.service === 'turn_off'));

  console.log('\n########## 3. Integracion NO admin del portero: oculto aunque la entidad exista y el usuario de HA sea admin ##########');
  await page.evaluate(() => {
    window.tSetAdmin(true);   // the HA user IS an admin -- and that must not be enough
    window.tSetRole('user'); // but the integration isn't the doorbell's administrator
    window.tCreateCard('c', { rec_entity: 'switch.rec_test' });
    window.tAttach('c');
    window.tRefreshHass('c');
  });
  await sleep(100);
  let recNonAdmin = await page.evaluate(() => window.__cards['c'].recAction.style.display);
  check('oculto cuando la integracion no es administradora del portero, aunque el usuario de HA si lo sea', recNonAdmin === 'none');

  console.log('\n########## 3-bis. Rol "unknown" (emparejamiento sin etiqueta, §3.3-ter): tambien oculto ##########');
  await page.evaluate(() => {
    window.tSetRole('unknown');
    window.tCreateCard('c2', { rec_entity: 'switch.rec_test' });
    window.tAttach('c2');
    window.tRefreshHass('c2');
  });
  await sleep(100);
  let recUnknown = await page.evaluate(() => window.__cards['c2'].recAction.style.display);
  check('oculto con rol "unknown"', recUnknown === 'none');
  await page.evaluate(() => window.tSetRole('admin'));

  console.log('\n########## 4. El chip de modo (ahora desplegable, v1.9.5) sigue llamando a select.select_option ##########');
  // (v1.9.5) The row of 4 segmented chips was replaced by ONE dropdown chip ("the modes should
  // also be a dropdown chip", Iñaki 2026-09-25) - it has to be opened first, just like in the
  // real app (PopupMenuButton). See test/ui_v1_9_5/driver.js for the dedicated checks on the
  // new look; this one still lives here because it's the same select_option call that already
  // covered 1.9.2.
  await page.evaluate(() => {
    window.tSetHassState('select.modo_test', 'normal', { options: ['normal', 'away', 'do_not_disturb', 'custom'] });
    window.tCreateCard('d', { mode_entity: 'select.modo_test' });
    window.tAttach('d');
    window.tRefreshHass('d');
  });
  await sleep(150);
  await page.evaluate(() => { window.tClick('d', '#mode-pill'); }); // opens the dropdown
  await sleep(50);
  await page.evaluate(() => { window.__calledServices.length = 0; window.tClick('d', '.mode-opt[data-option="away"]'); });
  await sleep(50);
  calls = await page.evaluate(() => window.__calledServices.slice());
  check('el chip de modo llama a select.select_option con la opcion pulsada', calls.some((c) => c.domain === 'select' && c.service === 'select_option' && c.data.option === 'away'));

  console.log('\n########## 5. Altavoz reubicado: sin deslizador de volumen, el boton alterna mute ##########');
  await page.evaluate(() => { window.tCreateCard('e', {}); window.tAttach('e'); });
  await sleep(100);
  const noSlider = await page.evaluate(() => !window.__cards['e'].querySelector('#vol-slider'));
  check('no existe ya #vol-slider en el DOM', noSlider);
  const sndInActionsRow = await page.evaluate(() => {
    const c = window.__cards['e'];
    const btn = c.querySelector('#snd-btn');
    return !!btn && !!btn.closest('.actions-row') && btn.classList.contains('btn') && btn.classList.contains('snd');
  });
  check('el boton de sonido vive en la fila de acciones (btn.snd)', sndInActionsRow);
  const audioBefore = await page.evaluate(() => window.__cards['e']._audioOn);
  await page.evaluate(() => window.tClick('e', '#snd-btn'));
  await sleep(30);
  const audioAfter = await page.evaluate(() => window.__cards['e']._audioOn);
  check('un toque en el altavoz invierte _audioOn (arranca mudo)', audioBefore === false && audioAfter === true);

  console.log('\n########## 6. Selector de calidad y reloj superpuesto: retirados del DOM ##########');
  const goneEls = await page.evaluate(() => {
    const c = window.__cards['e'];
    return {
      quality: !!c.querySelector('#hud-quality'),
      clock: !!c.querySelector('#hud-time'),
    };
  });
  check('#hud-quality ya no existe (chip de calidad retirado)', goneEls.quality === false);
  check('#hud-time ya no existe (reloj superpuesto retirado)', goneEls.clock === false);

  console.log('\n########## 7. Orden de la fila de botones: sonido, micro, abrir (REC ya no vive aqui, v1.9.5) ##########');
  const order = await page.evaluate(() => {
    window.tSetHassState('switch.rec_order', 'off', {});
    const c = document.createElement('ig-doorbell-view');
    c.hass = { language: 'es', user: { is_admin: true }, states: window.__states, callService: () => Promise.resolve(), connection: { sendMessagePromise: async () => { throw { code: 'not_found' }; } } };
    c.setConfig({ device_id: 'order-test', rec_entity: 'switch.rec_order' });
    document.getElementById('host').appendChild(c);
    c.hass = c._hass;
    const ids = Array.from(c.querySelectorAll('.actions-row .action button')).map((b) => b.id);
    return { ids, recInHeader: !!c.querySelector('#top-row #rec-button'), recInActionsRow: !!c.querySelector('.actions-row #rec-button') };
  });
  check(`orden real: ${JSON.stringify(order.ids)}`, JSON.stringify(order.ids) === JSON.stringify(['snd-btn', 'mic-button', 'unlock-button']));
  check('REC vive en la cabecera (#top-row), no en la fila de botones (v1.9.5)', order.recInHeader === true && order.recInActionsRow === false);

  console.log('\n########## 8. Pantalla completa: toggle no lanza excepcion y deja un estado consistente ##########');
  // ⚠️ page.evaluate()+dispatchEvent('click') does NOT work here: it's a synthetic event with no user
  // activation, and requestFullscreen() ALWAYS rejects it for that reason (not because of anything in the card) - the
  // harness would be measuring its own limitation, not the code. Playwright's page.click() does go through CDP
  // as a real input and counts as a user gesture, just like an actual tap.
  await page.evaluate(() => { window.tCreateCard('f', {}); window.tAttach('f'); });
  await sleep(100);
  const fsBtnHandle = await page.evaluateHandle(() => window.__cards['f'].querySelector('#fs-btn'));
  await fsBtnHandle.asElement().click();
  await sleep(300);
  const fsState = await page.evaluate(() => {
    const c = window.__cards['f'];
    return {
      hasDataFs: c.hasAttribute('data-fs'),
      fsActive: !!c._fsActive,
      fsNative: !!c._fsNative,
      nativeLayoutClass: c.classList.contains('ig-fs-native-layout'),
      pseudoClass: c.content.classList.contains('ig-fs-pseudo'),
      isDocFsElement: document.fullscreenElement === c,
    };
  });
  console.log('  estado tras el primer toque:', JSON.stringify(fsState));
  check('data-fs presente tras activar', fsState.hasDataFs === true);
  check('_fsActive true', fsState.fsActive === true);
  // Internal consistency: native <=> has the safety class AND does NOT have ig-fs-pseudo; fallback <=> the other way around.
  const consistente = fsState.fsNative
    ? (fsState.nativeLayoutClass === true && fsState.pseudoClass === false)
    : (fsState.nativeLayoutClass === false && fsState.pseudoClass === true);
  check('el modo (nativo/respaldo) y sus clases CSS coinciden entre si', consistente);
  await fsBtnHandle.asElement().click();
  await sleep(200);
  const fsAfterExit = await page.evaluate(() => {
    const c = window.__cards['f'];
    return { hasDataFs: c.hasAttribute('data-fs'), nativeLayoutClass: c.classList.contains('ig-fs-native-layout') };
  });
  check('sale de pantalla completa: sin data-fs', fsAfterExit.hasDataFs === false);
  check('sale de pantalla completa: sin la clase de seguridad nativa', fsAfterExit.nativeLayoutClass === false);

  await browser.close();
  console.log(`\n${fails === 0 ? 'TODO OK' : `${fails} FALLO(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
