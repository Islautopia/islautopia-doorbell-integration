// Measures in a real Chromium WHY the video doesn't come back on tapping the card after it's
// released for idleness, WITHOUT replacing startWebRTC() (unlike the sibling harness
// test-idle-release-browser, whose total replacement of startWebRTC() masks exactly the race that
// needs to be seen). Loads the real dist/ig-doorbell-card.js; harness.js only doubles fetch/
// EventSource/WebSocket/hass.connection.sendMessagePromise -- the network layer, never the card's
// logic.
//
// RUN:
//   1. From the worktree root: `python -m http.server 8792`
//   2. `node test/idle_release_network/driver.js`
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8792/tests/card/idle_release_network/index.html';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function newPage(browser) {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('TESTLOG')) console.log(t.replace(/^TESTLOG /, ''));
    else if (msg.type() === 'error') console.log('[console.error] ' + t);
    else if (msg.type() === 'warning') console.log('[console.warn] ' + t);
    else if (msg.type() === 'info' || msg.type() === 'log') console.log('[console.' + msg.type() + '] ' + t);
  });
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness listo')));
  return page;
}

// Polls tState(id) every `stepMs` up to `totalMs`, printing every sample -- to see EXACTLY
// when (if ever) hasPc goes back to true after the tap, instead of only looking at the end.
async function pollState(page, id, totalMs, stepMs) {
  let elapsed = 0;
  const samples = [];
  while (elapsed <= totalMs) {
    const s = await page.evaluate((id) => window.tState(id), id);
    samples.push({ t: elapsed, ...s });
    console.log(`  t+${elapsed}ms: hasPc=${s.hasPc} streamPausedByHide=${s.streamPausedByHide} connGen=${s.connGen} arranqueEnVueloGen=${s.arranqueEnVueloGen} nativeWS=${s.nativeWS}`);
    await sleep(stepMs);
    elapsed += stepMs;
  }
  return samples;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // STRUCTURAL POSITIVE CONTROL: the harness has to KNOW HOW TO SEE a restoration when it genuinely
  // happens, through a path already trusted as good (visibilitychange), before trusting what it says
  // about the idle+tap path. If this doesn't detect the restoration, the harness is blind and
  // nothing further below is worth anything.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CONTROL POSITIVO: soltar por visibilitychange y reponer por visibilitychange ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true });
      window.tCreateCard('p', { idle_release_seconds: 0 }); // 0 = disables the idle clock, doesn't interfere
      window.tAttach('p');
    });
    await sleep(600);
    const before = await page.evaluate(() => window.tState('p'));
    console.log('estado tras conectar:', JSON.stringify(before));
    await page.evaluate(() => window.tHide('p'));
    await sleep(200);
    const hidden = await page.evaluate(() => window.tState('p'));
    console.log('estado tras ocultar (visibilitychange):', JSON.stringify(hidden));
    await page.evaluate(() => window.tShow('p'));
    await sleep(600);
    const shown = await page.evaluate(() => window.tState('p'));
    console.log('estado tras volver a mostrar:', JSON.stringify(shown));
    const veredicto = !before.hasPc ? 'CONTROL INVALIDO (no conecto de entrada)'
      : (hidden.hasPc ? 'CONTROL INVALIDO (no solto al ocultar)'
        : (shown.hasPc ? 'CONTROL POSITIVO OK: el arnes SI ve una reposicion cuando ocurre' : 'CONTROL INVALIDO (tampoco repuso por visibilitychange -- arnes sospechoso)'));
    console.log('=> ' + veredicto);
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 1 (the fact to explain, FAST/normal network): short idle_release_seconds, let it release
  // on its own, then tap. startWebRTC() is the REAL code -- if this restores, the basic mechanism
  // works with a fast network and the failure has to be looked for in harsher conditions. If it does NOT
  // restore, the failure is fundamental and no slow network is needed to see it.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASO 1: idle_release_seconds=2, red normal (rapida), soltar solo y luego TOCAR ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c1', { idle_release_seconds: 2 });
      window.tAttach('c1');
    });
    await sleep(500);
    console.log('estado tras conectar:', JSON.stringify(await page.evaluate(() => window.tState('c1'))));
    await sleep(2600); // > 2s past the deadline
    const released = await page.evaluate(() => window.tState('c1'));
    console.log('estado tras el plazo de inactividad (SIN tocar):', JSON.stringify(released));
    if (released.hasPc) {
      console.log('=> CASO 1 INVALIDO: no llego a soltarse solo, no se puede probar el toque');
    } else {
      console.log('-- tocando ahora, y muestreando el estado cada 500ms durante 13s (pasado el fusible de 12s) --');
      await page.evaluate(() => window.tTouch('c1'));
      const samples = await pollState(page, 'c1', 13000, 500);
      const recuperado = samples.some((s) => s.hasPc);
      console.log('=> CASO 1: ' + (recuperado ? 'SE REPUSO (hasPc volvio a true en algun momento)' : 'NO SE REPUSO EN 13s -- reproducido el sintoma'));
    }
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 2 (suspicion 1: reentrancy guard): the first startWebRTC() gets STUCK HALFWAY
  // (the relay never opens or fails -- wsOutcome='hang'), so its promise never resolves and
  // _startInFlightGen stays alive with THAT startup's value when idleness kicks in. It's
  // left to release on idle (which still sees this.pc truthy, assigned before the relay) and it's
  // tapped. Does the guard block the second startup? Does the 12s fuse kick in?
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASO 2: primer arranque COLGADO (relay nunca abre/falla), idle_release_seconds=2, luego TOCAR ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'hang', turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c2', { idle_release_seconds: 2 });
      window.tAttach('c2');
    });
    await sleep(500);
    const midflight = await page.evaluate(() => window.tState('c2'));
    console.log('estado con el primer arranque colgado en el relay:', JSON.stringify(midflight));
    await sleep(2600);
    const released = await page.evaluate(() => window.tState('c2'));
    console.log('estado tras el plazo de inactividad (arranque original SIGUE colgado):', JSON.stringify(released));
    console.log('-- tocando ahora, muestreando 13s (fusible START_IN_FLIGHT_MAX_MS=12000ms) --');
    await page.evaluate(() => window.tTouch('c2'));
    const samples = await pollState(page, 'c2', 13000, 500);
    const qrLocked = samples.some((s) => s.arranqueEnVueloGen !== null && !s.hasPc);
    const recuperado = samples.some((s) => s.hasPc);
    console.log(`=> CASO 2: arranqueEnVuelo visto no-null en algun momento tras tocar=${qrLocked}; ` + (recuperado ? 'SE REPUSO' : 'NO SE REPUSO EN 13s'));
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 3 (suspicion 3: two producers of _streamPausedByHide): while the card stays on screen
  // (without hiding or leaving the view), idleness runs out. Before tapping, a visibilitychange
  // to 'hidden' and then immediately 'visible' ALSO fires (e.g. the browser switching
  // tabs for an instant, or any spurious event) to see whether the second producer
  // would leave _streamPausedByHide in a state the tap no longer recognizes as "needs restoring".
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASO 3: idle-release + visibilitychange espurio ANTES de tocar ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c3', { idle_release_seconds: 2 });
      window.tAttach('c3');
    });
    await sleep(500);
    await sleep(2600);
    const released = await page.evaluate(() => window.tState('c3'));
    console.log('estado tras el plazo de inactividad:', JSON.stringify(released));
    console.log('-- disparando visibilitychange hidden->visible espurio (la pagina nunca deja de estar activa de verdad) --');
    await page.evaluate(() => { window.tHide('c3'); });
    await sleep(50);
    const afterHideSpurious = await page.evaluate(() => window.tState('c3'));
    console.log('estado tras el hidden espurio:', JSON.stringify(afterHideSpurious));
    await page.evaluate(() => { window.tShow('c3'); });
    await sleep(300);
    const afterShowSpurious = await page.evaluate(() => window.tState('c3'));
    console.log('estado tras el show espurio (¿reconecto solo, sin tocar?):', JSON.stringify(afterShowSpurious));
    console.log('-- ahora SI se toca --');
    await page.evaluate(() => window.tTouch('c3'));
    const samples = await pollState(page, 'c3', 4000, 500);
    const recuperado = samples.some((s) => s.hasPc);
    console.log('=> CASO 3: ' + (recuperado ? 'SE REPUSO tras el toque' : 'NO SE REPUSO tras el toque'));
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 4 (fine-grained race): the FASTEST POSSIBLE network (connInfoDelay=0, turnDelay=0 -- resolved
  // via microtask, no setTimeout) to see whether this.pc can get assigned BEFORE the
  // just-armed idle clock itself (with the ABSOLUTE clock already expired, see
  // _armIdleWakeLockTimer) fires its "remaining <= 0" check -- which is a setTimeout(0)
  // scheduled EARLIER, synchronously, at the very start of startWebRTC(). If this check gets to
  // see this.pc already set, it self-releases the connection the tap just restored.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASO 4: red lo mas rapida posible tras el toque -- carrera fina pc-vs-reloj-de-inactividad ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 10, wsOutcome: 'open', wsDelay: 10, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 10 });
      window.tCreateCard('c4', { idle_release_seconds: 2 });
      window.tAttach('c4');
    });
    await sleep(500);
    await sleep(2600);
    const released = await page.evaluate(() => window.tState('c4'));
    console.log('estado tras el plazo de inactividad:', JSON.stringify(released));
    // Now the network becomes instantaneous (pure microtask) ONLY for whatever decides the race.
    await page.evaluate(() => window.tSetNetCfg({ connInfoDelay: 0, turnDelay: 0 }));
    console.log('-- tocando con red instantanea, muestreando cada 5ms los primeros 300ms --');
    await page.evaluate(() => window.tTouch('c4'));
    let sawArmedTrue = false;
    let sawPcTrueThenFalseFast = false;
    let prevPc = false;
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(() => window.tState('c4'));
      if (s.idleTimerArmed) sawArmedTrue = true;
      if (prevPc && !s.hasPc) sawPcTrueThenFalseFast = true;
      prevPc = s.hasPc;
      if (i < 20 || i % 5 === 0) console.log(`  t+${i * 5}ms: hasPc=${s.hasPc} streamPausedByHide=${s.streamPausedByHide} idleTimerArmed=${s.idleTimerArmed} connGen=${s.connGen}`);
      await sleep(5);
    }
    const final = await page.evaluate(() => window.tState('c4'));
    console.log('estado final (300ms tras el toque):', JSON.stringify(final));
    console.log(`=> CASO 4: idleTimerArmed visto en true en algun momento=${sawArmedTrue}; pc paso de true a false otra vez tras el toque=${sawPcTrueThenFalseFast}; hasPc final=${final.hasPc}`);
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 5 (a one-shot idle clock): after releasing on idle and restoring with
  // a tap, does the idle clock get armed again for a SECOND automatic cycle? If the
  // restoring tap never updates LAST_INTERACTION_MS (see the early `return` in
  // _onIdleActivity's "restore" branch), the check startWebRTC() arms sees the clock already
  // expired, fires almost instantly, finds nothing to release (or releases what was just restored,
  // CASE 4) and in NO case does it reschedule itself -- so the automatic idle clock
  // would stop firing EVER AGAIN in this session, even if the user leaves the
  // card untouched for however long.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASO 5: tras reponerse por toque, ¿el reloj de inactividad vuelve a disparar solo? ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 40, wsOutcome: 'open', wsDelay: 40, turnFail: true,
        connInfoDelay: 30, turnDelay: 30, localSignalUrlDelay: 30 });
      window.tCreateCard('c5', { idle_release_seconds: 2 });
      window.tAttach('c5');
    });
    await sleep(500);
    await sleep(2600);
    console.log('estado tras el PRIMER plazo de inactividad:', JSON.stringify(await page.evaluate(() => window.tState('c5'))));
    await page.evaluate(() => window.tTouch('c5'));
    await sleep(500);
    const afterTouch = await page.evaluate(() => window.tState('c5'));
    console.log('estado 500ms tras el toque (reconectado):', JSON.stringify(afterTouch));
    console.log('-- esperando 6s SIN tocar (3x el plazo configurado) para ver si el reloj de inactividad dispara un SEGUNDO ciclo automatico --');
    const samples = await pollState(page, 'c5', 6000, 1000);
    const segundoDisparo = samples.some((s) => !s.hasPc);
    console.log('=> CASO 5: ' + (segundoDisparo
      ? 'el reloj SI volvio a disparar solo (el idle-release automatico sigue vivo tras un ciclo)'
      : 'el reloj NO volvio a disparar en 6s -- reproducido: el idle-release automatico murio tras el primer ciclo toque-reposicion'));
    await page.close();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // CASE 6 (same mechanism, REALISTIC network -- not an instant microtask): 5-10ms per hop, on the
  // order of a Home Assistant WebSocket on the same machine/LAN. Confirms that CASE 4 isn't
  // an artifact of the "0ms = pure microtask" trick: with small but real network hops
  // (a genuine setTimeout), this.pc can still make it in time for the expired idle clock
  // to find it set and self-destroy the reconnection.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  {
    const page = await newPage(browser);
    console.log('\n########## CASO 6: mismo mecanismo con red RAPIDA REALISTA (5-10ms, sin microtarea instantanea) ##########');
    await page.evaluate(() => {
      window.tSetNetCfg({ esOutcome: 'error', esDelay: 8, wsOutcome: 'open', wsDelay: 8, turnFail: true,
        connInfoDelay: 6, turnDelay: 6, localSignalUrlDelay: 6 });
      window.tCreateCard('c6', { idle_release_seconds: 2 });
      window.tAttach('c6');
    });
    await sleep(500);
    await sleep(2600);
    console.log('estado tras el plazo de inactividad:', JSON.stringify(await page.evaluate(() => window.tState('c6'))));
    console.log('-- tocando con red rapida REALISTA (setTimeout de 6-8ms, no microtarea), muestreando cada 5ms --');
    await page.evaluate(() => window.tTouch('c6'));
    let sawPcTrue = false;
    for (let i = 0; i < 40; i++) {
      const s = await page.evaluate(() => window.tState('c6'));
      if (s.hasPc) sawPcTrue = true;
      if (i < 15 || i % 4 === 0) console.log(`  t+${i * 5}ms: hasPc=${s.hasPc} streamPausedByHide=${s.streamPausedByHide} connGen=${s.connGen}`);
      await sleep(5);
    }
    const final6 = await page.evaluate(() => window.tState('c6'));
    console.log('estado final (200ms tras el toque):', JSON.stringify(final6));
    console.log(`=> CASO 6: this.pc se vio truthy en ALGUN muestreo=${sawPcTrue}; estado final hasPc=${final6.hasPc} streamPausedByHide=${final6.streamPausedByHide}`);
    await page.close();
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
