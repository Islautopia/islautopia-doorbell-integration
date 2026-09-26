// Isolated simulation of startWebRTC()'s REENTRANCY RACE and the idle clock,
// with no browser, no Home Assistant, no doorbell.
//
//   node test/sim_carrera_reentrada.js dist/ig-doorbell-card.js
//   node test/sim_carrera_reentrada.js --controles          <- THIS is what needs to be run
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT IT MEASURES, AND WHY IT CAN'T BE MEASURED BY READING THE CODE
//
//  The bug this chases (measured 2026-09-07 on the living-room tablet) is the kind that CANNOT be seen
//  by reading: three connections opened in 0.3 s after a ring and only the LAST one closed. It depends
//  entirely on the order in which several waits resolve, and that order isn't written anywhere
//  in the file. Here it's reproduced with controlled clocks.
//
//  The REAL dist/ file gets loaded (not a copy) and NOTHING under test gets replaced:
//  startWebRTC, startNativeSession, buildNativePeerConnection, tryLocalSignaling,
//  startRelaySignaling, _teardownConnectionObjects, _superseded and _armIdleWakeLockTimer run
//  exactly as they are in the dist. The only thing replaced is the NETWORK LAYER (WebSocket,
//  EventSource, fetch, RTCPeerConnection, AudioContext, HA's WebSocket) and the UI sheets that
//  have nothing to do with this (painting pills, the mic state, the door).
//
//  ⚠️ PHASE 0 (2026-09-25): the card no longer has a relay or STUN/TURN. Signaling goes ONLY through
//  Home Assistant's proxy (EventSource over the signed URL), so what's counted now is
//  EventSources, not WebSockets. The EventSource double delivers the offer; the race's window
//  is opened by the `get_local_signal_url` wait (before: the TURN credentials). Cases
//  8-13 are the new rules: deadline from the entity, call veto, live_pause -> grace -> bye,
//  tap and ring that resume, and no path outside Home Assistant.
//
//  ⚠️ WHAT THIS IS NOT: it doesn't talk to a doorbell, doesn't negotiate ICE/DTLS, and doesn't prove
//  that, in Chromium, an IntersectionObserver sees what's expected. A green here is NOT "it works on the
//  wallpanel". It's "the reentrancy state machine does what it says it does".
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE CONTROLS, WHICH ARE THE SERIOUS HALF OF THIS FILE (CLAUDE.md: "an instrument with no negative
//  test isn't a weak measurement: it isn't a measurement")
//
//  A bench that always said OK would pass just as well. `--controles` takes it apart from both
//  sides, and EACH control is of the same kind and in the same shape as what's being measured:
//
//   · NEGATIVE CONTROL -- the file from BEFORE the fix (commit 3983f68, never a branch
//     name: see the note in COMMIT_PREVIO) has to FAIL cases 1 and 5. If it passed them, this
//     bench wouldn't be seeing the real bug.
//   · POSITIVE CONTROL A -- a mutant whose guard NEVER lets anything through (a `return` on entering
//     startWebRTC) has to FAIL case 2. Without this control, the easiest way to "fix"
//     a buildup of connections would be to never connect at all, and every other case would come out
//     green with the card black forever.
//   · POSITIVE CONTROL B -- a mutant with `_superseded()` always `false` (i.e.: reentrancy guard
//     yes, generation counter no) has to FAIL case 3. This is what
//     proves both pieces are needed and that case 3 genuinely measures the second one.
//   · POSITIVE CONTROL C -- a mutant that reproduces the old bug (a tap updates the
//     mark without rearming the clock) AND ALSO skips the re-check of the absolute deadline has
//     to FAIL case 7, the one about NOT releasing the video while someone is touching. Both mutations
//     are deliberately combined: either one of the two defenses is enough on its own to cover the bug, and
//     with only one of them mutated case 7 would still be green -- meaning the control would distinguish
//     nothing. That both are needed to break it is, in fact, the proof that both defend.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const pathmod = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  Network-layer doubles. Each one carries its own counter: what's measured is HOW MANY open and
//  how many close, which is exactly the real bug's signature ("of N, one closes").
// ─────────────────────────────────────────────────────────────────────────────────────────────
function construirEntorno(reloj) {
  const censo = { ws: [], pc: [], es: [], iceServers: [], fetch: [] };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.cerrado = false;
      this.enviados = [];
      censo.ws.push(this);
      setTimeout(() => {
        if (this.cerrado) return;
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }, reloj.wsOpenMs);
    }
    send(d) { this.enviados.push(d); }
    close() { this.cerrado = true; this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  }
  FakeWebSocket.OPEN = 1;

  class FakePeerConnection {
    constructor(cfg) { this.cfg = cfg; this.cerrado = false; this.connectionState = 'new'; censo.pc.push(this); censo.iceServers.push(cfg && cfg.iceServers); }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv' }; }
    async setLocalDescription() {}
    get remoteDescription() { return {}; }
    addTransceiver() { return { direction: 'recvonly', sender: {} }; }
    addTrack(t) { const s = { track: t, replaceTrack: async () => {} }; this._sender = s; return s; }
    getTransceivers() { return [{ sender: this._sender, direction: 'sendrecv' }]; }
    async getStats() { return new Map(); }
    close() { this.cerrado = true; }
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url; this.cerrado = false; censo.es.push(this);
      // The doorbell assigns a slot and sends the offer as soon as it accepts the SSE (§1.4).
      setTimeout(() => {
        if (this.cerrado || !this.onmessage) return;
        this.onmessage({ data: JSON.stringify({ type: 'offer', slot: 0, sdp: 'v=0' }) });
      }, reloj.esOfertaMs || 5);
    }
    close() { this.cerrado = true; }
  }

  class FakeAudioContext {
    constructor() { this.cerrado = false; }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ id: 'muda', stop() {} }] } };
    }
    close() { this.cerrado = true; }
  }

  return { censo, FakeWebSocket, FakePeerConnection, FakeEventSource, FakeAudioContext };
}

function cargarClase(src, entorno, oyentesDoc) {
  let CardClass = null;
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    HTMLElement: class {},
    WebSocket: entorno.FakeWebSocket,
    EventSource: entorno.FakeEventSource,
    RTCPeerConnection: entorno.FakePeerConnection,
    IntersectionObserver: class { observe() {} disconnect() {} },
    // The local path's reachability probe: it's rejected, so the local path is abandoned
    // right away and the whole race window ends up governed by `reloj.turnMs`, which is what
    // we want to control. (On the real device that window is opened by the TURN request to Germany.)
    fetch: (url) => { entorno.censo.fetch.push(url); return Promise.reject(new Error('sin red en la simulacion')); },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},                       // WITHOUT wakeLock, like the wallpanel's webview
    document: {
      visibilityState: 'visible',
      createElement: () => ({ style: {}, setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} } }),
      addEventListener(t, f) { (oyentesDoc[t] = oyentesDoc[t] || []).push(f); },
      removeEventListener() {},
      body: { classList: { add() {}, remove() {} } },
    },
    window: { addEventListener() {}, removeEventListener() {}, AudioContext: entorno.FakeAudioContext },
    customElements: { get: () => undefined, define: (n, c) => { if (n === 'ig-doorbell-view' || (n === 'ig-doorbell-card' && !CardClass)) CardClass = c; } },  // pre-1.10.0 commits (negative control) have no view element: the card IS the view
  };
  sandbox.window.customCards = [];
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (CardClass) CardClass.__doc = sandbox.document;   // the visibility cases change visibilityState
  return CardClass;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  A live card without going through setConfig()/render(): same initial state, no DOM.
//  ONLY UI sheets get replaced. None of the connection machinery.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function nuevaCard(CardClass, opciones) {
  const c = Object.create(CardClass.prototype);
  const o = opciones || {};
  c.config = { device_id: 'abc' };
  c._hass = {
    connection: {
      sendMessagePromise: (msg) => {
        if (msg.type === 'ig_doorbell/get_connection_info') {
          // Phase 0: no credential or relay; the entities the card reads.
          const info = { device_id: 'abc', live_timeout_entity: o.plazoEntidad === undefined ? null : 'number.x_live_view_timeout', events_entity: 'event.x_events' };
          // The BEFORE code (negative control) read these two: they're given to it so it can follow its path.
          info.relay_ws_url = 'wss://relay/ws'; info.credential = 'X';
          return new Promise((r) => setTimeout(() => r(info), o.infoMs || 0));
        }
        // The race window: it used to be opened by the TURN request, today by the signed URL's.
        if (msg.type === 'ig_doorbell/get_turn_credentials' || msg.type === 'ig_doorbell/get_local_signal_url') {
          if (o.turnColgado) return new Promise(() => {});   // never resolves: the fuse case
          const r0 = msg.type === 'ig_doorbell/get_turn_credentials' ? { urls: [] } : { signal_url: '/api/ig_doorbell/signal/abc?authSig=x' };
          return new Promise((r) => setTimeout(() => r(r0), o.turnMs || 0));
        }
        return Promise.reject(new Error('desconocido'));
      },
    },
    states: o.estados || {},
    callApi: (metodo, ruta, cuerpo) => { c._enviados.push(cuerpo); return Promise.resolve({}); },
  };
  c._enviados = [];
  if (o.plazoEntidad !== undefined) c._hass.states['number.x_live_view_timeout'] = { state: String(o.plazoEntidad) };
  Object.assign(c, {
    pc: null, nativeSSE: null, nativeWS: null, _slot: null,
    _connGen: 0, _startInFlightGen: null, _startInFlightAt: 0,
    _watchdogTimer: null, _reconnectTimer: null, _reconnectAttempt: 0, _reconnecting: false,
    _lastLifeSignalAt: null, _prevPacketsReceived: null,
    _idleReleaseMs: o.idleMs === undefined ? 0 : o.idleMs,
    _idleWakeLockTimer: null, _wakeLock: null, _fsActive: false,
    _pauseState: null, _pauseGraceTimer: null, _idleGraceMs: o.graciaMs === undefined ? 15000 : o.graciaMs,
    _livePauseWanted: false, _livePauseAck: null, _rescueTimers: [],
    _talkHeld: false, _talkPending: false,
    talkActive: false, localAudioStream: null, dummyAudioTrack: null,
    _audioOn: false, _audioOnBeforeMic: false, _listenOnly: false,
    isConnected: true, content: true,
  });
  // UI sheets: none of this takes part in the race or the clock.
  c._mark = () => {};
  c._flashStatusLine = () => {};
  c._resetStatusLine = () => {};
  c._setLiveState = () => {};
  c._paintMicState = () => {};
  c._updateMotionPill = () => {};
  c._resetMulticlientState = () => {};
  c._disarmDoorConfirm = () => {};
  c._clearDoorWait = () => {};
  c._setAudioOn = () => {};
  c._stopAudioSendDiagnostics = () => {};
  c._startRetryCountdown = () => {};
  c._stopRetryCountdown = () => {};
  c._reportPairingRejected = () => {};
  c._probeQualitySupport = () => {};
  c._setDoorLabel = () => {};
  c._acquireWakeLock = async () => {};        // there's no navigator.wakeLock, same as on the tablet
  c._releaseWakeLock = () => {};
  // _registerIdleActivityListeners is NOT replaced: case 7 depends on the real interaction
  // handler existing, which is the path the bug came in through. Only the element's own
  // addEventListener gets a double.
  c.addEventListener = () => {};
  c.removeEventListener = () => {};
  c._registerUnloadHandler = () => {};
  c._sueltas = [];
  return c;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Collects a card at the end of a case WITHOUT assuming the new functions exist: the controls
// also run the old code, and there a missing method must show up as a case in red,
// not take down the whole bench.
function limpiar(c) {
  for (const f of ['_cancelPause', '_teardownConnectionObjects', '_clearIdleWakeLockTimer']) {
    if (typeof c[f] === 'function') { try { c[f](); } catch (err) { /* collected */ } }
  }
}

// The BEFORE code (negative control) handles offers from already-superseded sessions on a null `pc`
// and rejects promises nobody's waiting on. That's part of the bug the control must SEE through its effect
// (accumulated connections), not a reason for the whole bench to crash without reporting.
let rechazosSinAtender = 0;
process.on('unhandledRejection', (e) => { rechazosSinAtender += 1; if (process.env.SIM_DEBUG) console.error('RECHAZO', e); });

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  The cases
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function ejecutar(src, mostrar) {
  const fallos = [];
  const oyentesDoc = {};
  const entorno = construirEntorno({ wsOpenMs: 5 });
  const CardClass = cargarClase(src, entorno, oyentesDoc);
  if (!CardClass) return { fallos: ['could not capture the class'], total: 0 };

  let total = 0;
  const comp = (optLabel, cond) => {
    total += 1;
    if (!cond) fallos.push(optLabel);
    if (mostrar) console.log(`  ${cond ? 'OK   ' : 'FALLO'} ${optLabel}`);
  };
  const seccion = (t) => { if (mostrar) console.log(`\n== ${t} ==`); };

  const vivos = (lista) => lista.filter((x) => !x.cerrado).length;

  // ── 1. THE MEASURED BUG ─────────────────────────────────────────────────────────────────────
  // Three triggers in 0.3 s (a ring: visibilitychange + render + connectedCallback) with the
  // TURN request taking 400 ms. Before the fix: 3 WebSockets open, 1 closed.
  seccion('1. Tres arranques en 0,3s tras un timbrazo (el fallo medido)');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 400 });
    c.startWebRTC('visibilitychange');
    await esperar(140);
    c.startWebRTC('render');
    await esperar(160);
    c.startWebRTC('connectedCallback');
    await esperar(900);
    comp(`EventSources VIVOS = 1 (abiertos ${e.censo.es.length}, vivos ${vivos(e.censo.es)})`, vivos(e.censo.es) === 1);
    comp(`RTCPeerConnection VIVAS = 1 (creadas ${e.censo.pc.length}, vivas ${vivos(e.censo.pc)})`, vivos(e.censo.pc) === 1);
    comp('  -> y el que queda vivo es el que la card tiene en this.nativeSSE', c.nativeSSE && !c.nativeSSE.cerrado);
    c._teardownConnectionObjects();
  }

  // ── 2. NO-BLOCKING CONTROL: a lone startup HAS to connect ─────────────────────────────────
  // Without this, "connections don't pile up" would also be satisfied by a card that never connects.
  seccion('2. Un arranque normal SI conecta (control de no bloquear)');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 20 });
    await c.startWebRTC('unico');
    await esperar(200);
    comp('hay sesion viva: pc asignada y sin cerrar', !!c.pc && !c.pc.cerrado);
    comp('hay EventSource por el proxy de Home Assistant, abierto', !!c.nativeSSE && !c.nativeSSE.cerrado && c.nativeSSE.url.startsWith('/api/ig_doorbell/signal/'));
    comp('  -> y se contesto a la oferta por el proxy', c._slot === 0 && c._enviados.some((m) => m.type === 'answer' && m.slot === 0));
    c._teardownConnectionObjects();
  }

  // ── 3. SUPERSESSION DURING A WAIT (this is what the generation counter measures) ──────────
  // The reentrancy guard does NOT cover this case: here the old startup has been torn down
  // out from under it (what _scheduleReconnect does), so the new one rightfully gets through. What stops the
  // leak is that the old one, on waking up, realizes it and closes its own.
  seccion('3. Desmontaje mientras un arranque espera (contador de generacion)');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 400 });
    c.startWebRTC('el que sera relevado');
    await esperar(120);
    c._teardownConnectionObjects();          // exactly what _scheduleReconnect() does
    c.startWebRTC('el relevo');
    await esperar(900);
    comp(`EventSources VIVOS = 1 (abiertos ${e.censo.es.length}, vivos ${vivos(e.censo.es)})`, vivos(e.censo.es) === 1);
    comp(`RTCPeerConnection VIVAS = 1 (creadas ${e.censo.pc.length}, vivas ${vivos(e.censo.pc)})`, vivos(e.censo.pc) === 1);
    comp('  -> el relevo SI quedo conectado (no se le comio el guardia)', !!c.nativeSSE && !c.nativeSSE.cerrado);
    c._teardownConnectionObjects();
  }

  // ── 4. FUSE: a stuck startup can't leave the card black forever ───────────────────────────
  seccion('4. Un arranque colgado se releva por fusible, no bloquea para siempre');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const opciones = { turnColgado: true };
    const c = nuevaCard(C, opciones);
    c.startWebRTC('el que se cuelga');
    await esperar(50);
    comp('mientras es joven, un segundo disparo se descarta', c._startInFlightGen !== null);
    c.startWebRTC('demasiado pronto');
    await esperar(50);
    comp('  -> y no ha abierto ninguna conexion de mas', e.censo.es.length === 0);
    // The marker is aged instead of waiting 12 s of real clock time: what's tested is the fuse's
    // rule, not setTimeout's punctuality.
    c._startInFlightAt = Date.now() - 60000;
    // And the network comes back: if the supersession also got stuck, this check could NEVER
    // pass and would be an impossible case disguised as a test -- the kind that reads as a product bug.
    opciones.turnColgado = false;
    c.startWebRTC('tras el fusible');
    await esperar(200);
    comp('pasado el fusible, un disparo nuevo SI arranca', !!c.nativeSSE && !c.nativeSSE.cerrado);
    c._teardownConnectionObjects();
  }

  // ── 5. THE IDLE CLOCK EXISTS WITHOUT wakeLock ─────────────────────────────────────────────
  // The sandbox's `navigator` has NO `wakeLock`, and the card never enters fullscreen:
  // exactly the wallpanel where v1.5.0/v1.5.1/v1.6.0 all three failed.
  seccion('5. El reloj de inactividad se arma sin wake lock y sin pantalla completa');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 300 });
    await c.startWebRTC('unico');
    await esperar(100);
    comp('hay cuenta atras armada con la sesion en marcha', !!c._idleWakeLockTimer);
    c._teardownConnectionObjects();
    if (c._idleWakeLockTimer) clearTimeout(c._idleWakeLockTimer);
  }

  // ── 6. AND IT FIRES: without touching anything, it releases the video ─────────────────────
  seccion('6. Sin interaccion, el plazo vence y suelta el video');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 250, graciaMs: 50 });
    await c.startWebRTC('unico');
    await esperar(600);
    comp('la sesion se ha soltado sola', c.pc === null);
    comp('  -> el EventSource esta cerrado', e.censo.es.every((w) => w.cerrado));
    comp('  -> y queda en pausa colgada, esperando a alguien', !!c._pauseState && c._pauseState.phase === 'hung_up');
  }

  // ── 7. NO-FIRE CONTROL: while touching, it can NEVER release ──────────────────────────────
  // This is the more important of the clock's two controls: cutting the video for someone who's
  // watching is a worse bug than leaving the screen on for too long.
  seccion('7. Con toques periodicos NO suelta jamas (control de no disparar)');
  {
    const e = construirEntorno({ wsOpenMs: 5 });
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 250 });
    await c.startWebRTC('unico');
    comp('el manejador real de interaccion esta registrado', typeof c._onIdleActivity === 'function');
    // One touch every 100 ms with a 250 deadline, via the REAL PATH: it fires the same
    // `_onIdleActivity` the card registers, not `_armIdleWakeLockTimer` by hand. The difference isn't
    // cosmetic -- it's exactly where the bug lived (a tap updated the mark without rearming), and
    // calling the timer directly would leave the case with nothing to detect.
    // If there's no handler (the code from before the fix never registers one) the loop is skipped:
    // the case has already marked it as a failure above, and crashing here would take down the rest
    // of the bench -- an instrument that crashes doesn't report, and in a control that reads as "it doesn't break".
    for (let i = 0; c._onIdleActivity && i < 12; i += 1) {
      await esperar(100);
      c._onIdleActivity();
    }
    // ⚠️ OPEN SESSIONS ARE COUNTED, THE FINAL STATE IS NOT LOOKED AT, and that difference is the whole
    // case. The first version checked `!!c.pc` at the end, and that was also passed by a card
    // that releases the video midway and restores it on the next tap: `pc` exists again, the
    // check comes out green, and the user still saw a black box. By counting how many
    // sessions have actually been built, "it released and came back" can no longer be disguised as "it never
    // released". (Found precisely because the mutant further below was passing this case.)
    comp(`tras 1,2s de toques con plazo de 0,25s NO se solto ni una vez (sesiones construidas: ${e.censo.pc.length})`, e.censo.pc.length === 1 && e.censo.es.length === 1);
    comp('  -> la sesion sigue viva', !!c.pc && !c.pc.cerrado);
    comp('  -> y no se marco como soltada', !c._pauseState);
    // Phase 0: expiring no longer hangs up right away (live_pause + grace), so "it paused and the
    // next tap resumed it" leaves no trace in pc/sessions. It shows up in what was sent to the doorbell.
    comp('  -> y no se mando ni un live_pause', !(c._enviados || []).some((m) => m.type === 'live_pause'));
    c._teardownConnectionObjects();
    if (c._idleWakeLockTimer) clearTimeout(c._idleWakeLockTimer);
  }

  // ══ PHASE 0 ═══════════════════════════════════════════════════════════════════════════════
  // ── 8. The deadline is set by the integration's entity ────────────────────────────────────
  seccion('8. El plazo sale de number.*_live_view_timeout (y 0 lo desactiva)');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 999000, plazoEntidad: 0.25, graciaMs: 20000 });
    await c.startWebRTC('unico');
    await esperar(500);
    comp('con la entidad a 0,25 s vence aunque el respaldo sea 999 s', !!c._pauseState && c._pauseState.phase === 'grace');
    limpiar(c);
    const c2 = nuevaCard(C, { turnMs: 10, idleMs: 250, plazoEntidad: 0 });
    await c2.startWebRTC('unico');
    await esperar(500);
    comp('  -> y con la entidad a 0 no vence nunca', !c2._pauseState && !!c2.pc);
    limpiar(c2);
  }

  // ── 9. Never with a call in progress ───────────────────────────────────────────────────────
  seccion('9. Con el micro abierto NO vence (§1.4-bis: never pause during a call)');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 250, graciaMs: 50 });
    await c.startWebRTC('unico');
    c.talkActive = true;
    await esperar(800);
    comp('con el micro abierto 0,8 s y plazo de 0,25 s: ni pausa ni bye', !c._pauseState && !!c.pc && !c.pc.cerrado);
    comp('  -> y no se mando live_pause', !c._enviados.some((m) => m.type === 'live_pause'));
    c.talkActive = false;
    limpiar(c);
  }

  // ── 10. On expiry: live_pause RIGHT AWAY, bye after grace (the slot is released) ───────────
  seccion('10. Vence: live_pause en el acto y bye tras la gracia');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 200, graciaMs: 300 });
    await c.startWebRTC('unico');
    const pc = c.pc;
    await esperar(350);
    comp('dentro de la gracia: live_pause enviado y la sesion sigue viva', c._enviados.some((m) => m.type === 'live_pause' && m.slot === 0) && c.pc === pc && !pc.cerrado);
    comp('  -> todavia sin bye', !c._enviados.some((m) => m.type === 'bye'));
    await esperar(400);
    comp('pasada la gracia: bye enviado (la ranura se libera ya, no a los 20 s)', c._enviados.some((m) => m.type === 'bye' && m.slot === 0));
    comp('  -> sesion cerrada y EventSource cerrado', c.pc === null && e.censo.es.every((x) => x.cerrado));
    comp('  -> y la card queda en pausa, esperando un toque', !!c._pauseState && c._pauseState.phase === 'hung_up');
  }

  // ── 11. A tap within the grace period resumes the SAME session ───────────────────────────
  seccion('11. Toque dentro de la gracia: live_resume, sin sesion nueva');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 200, graciaMs: 2000 });
    await c.startWebRTC('unico');
    await esperar(350);
    comp('esta en gracia', !!c._pauseState && c._pauseState.phase === 'grace');
    if (c._onIdleActivity) c._onIdleActivity();
    await esperar(50);
    comp('tras el toque: live_resume enviado', c._enviados.some((m) => m.type === 'live_resume'));
    comp('  -> la misma sesion, ninguna nueva', e.censo.pc.length === 1 && !!c.pc && !c.pc.cerrado);
    comp('  -> y sin bye', !c._enviados.some((m) => m.type === 'bye'));
    limpiar(c);
  }

  // ── 12. A ring wakes up the hung-up card; a package doesn't ─────────────────────────────────
  seccion('12. Timbrazo (event_type ring) tras colgar: sesion nueva; un paquete no');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 150, graciaMs: 50 });
    c.config.ring_entity = undefined;
    c._hass.states['event.x_events'] = { state: 't0', attributes: { event_type: 'ring' } };
    await c.startWebRTC('unico');
    c._updateRingState();                       // first read: doesn't fire
    await esperar(500);
    comp('colgada por inactividad', !!c._pauseState && c._pauseState.phase === 'hung_up' && c.pc === null);
    c._hass.states['event.x_events'] = { state: 't1', attributes: { event_type: 'package' } };
    c._updateRingState();
    await esperar(100);
    comp('un paquete NO la despierta', !!c._pauseState && c._pauseState.phase === 'hung_up' && e.censo.pc.length === 1);
    c._hass.states['event.x_events'] = { state: 't2', attributes: { event_type: 'ring' } };
    c._updateRingState();
    await esperar(60);
    comp('un timbrazo SI: sesion nueva', !c._pauseState && e.censo.pc.length === 2 && !!c.pc);
    limpiar(c);
  }

  // ── 13. No path outside Home Assistant ───────────────────────────────────────────────────
  seccion('13. Sin STUN/TURN, sin relay, sin fetch al portero: solo Home Assistant');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10 });
    await c.startWebRTC('unico');
    await esperar(100);
    comp('RTCPeerConnection sin iceServers', e.censo.iceServers.length === 1 && Array.isArray(e.censo.iceServers[0]) && e.censo.iceServers[0].length === 0);
    comp('  -> ningun WebSocket', e.censo.ws.length === 0);
    comp('  -> ningun fetch directo', e.censo.fetch.length === 0);
    comp('  -> y la SSE es la del proxy de HA', e.censo.es.every((x) => x.url.startsWith('/api/ig_doorbell/')));
    limpiar(c);
  }

  // ══ IÑAKI'S RULE 2026-09-25: OFF-SCREEN, PAUSE; ON RETURN, IN THE SAME STATE ═══════════════
  const ocultar = (C, c, v) => { C.__doc.visibilityState = v; c._onVisibilityForStream && c._onVisibilityForStream(); };

  // ── 14. Hiding: live_pause RIGHT AWAY, session alive; returning: live_resume, the same session ──
  seccion('14. Oculta -> live_pause inmediato; visible -> live_resume en la misma sesion');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 999000, graciaMs: 5000 });
    c._registerVisibilityStreamHandler && c._registerVisibilityStreamHandler();
    await c.startWebRTC('unico');
    await esperar(80);
    const pc = c.pc;
    ocultar(C, c, 'hidden');
    await esperar(30);
    comp('al ocultarse: live_pause enviado en el acto y la sesion sigue', c._enviados.some((m) => m.type === 'live_pause') && c.pc === pc && !pc.cerrado);
    comp('  -> sin bye todavia', !c._enviados.some((m) => m.type === 'bye'));
    ocultar(C, c, 'visible');
    await esperar(30);
    comp('al volver: live_resume, misma sesion, ninguna nueva', c._enviados.some((m) => m.type === 'live_resume') && c.pc === pc && e.censo.pc.length === 1);
    limpiar(c); C.__doc.visibilityState = 'visible';
  }

  // ── 15. Hidden WITH a call: pauses, but never hangs up; on return the turn is requested again ──
  seccion('15. Oculta con el micro abierto: live_pause, sin bye; al volver, talk_request');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 999000, graciaMs: 100 });
    c._registerVisibilityStreamHandler && c._registerVisibilityStreamHandler();
    c._stopTalk = function () { this.talkActive = false; this._talkHeld = false; };
    c._requestTalkTurn = function () { this.sendNativeSignal({ type: 'talk_request' }); };
    await c.startWebRTC('unico');
    await esperar(80);
    c.talkActive = true; c._talkHeld = true;
    ocultar(C, c, 'hidden');
    await esperar(400);
    comp('con llamada: live_pause y SIN bye pasada la gracia', c._enviados.some((m) => m.type === 'live_pause') && !c._enviados.some((m) => m.type === 'bye') && !!c.pc);
    ocultar(C, c, 'visible');
    await esperar(30);
    comp('  -> al volver: live_resume y se vuelve a pedir el turno (mismo estado)', c._enviados.some((m) => m.type === 'live_resume') && c._enviados.some((m) => m.type === 'talk_request'));
    limpiar(c); C.__doc.visibilityState = 'visible';
  }

  // ── 16. Hidden with no call: after the grace period, bye (the slot is released) ─────────────
  seccion('16. Oculta sin llamada: bye tras la gracia');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 999000, graciaMs: 100 });
    c._registerVisibilityStreamHandler && c._registerVisibilityStreamHandler();
    await c.startWebRTC('unico');
    await esperar(80);
    ocultar(C, c, 'hidden');
    await esperar(300);
    comp('sin llamada: bye pasada la gracia', c._enviados.some((m) => m.type === 'bye') && c.pc === null);
    ocultar(C, c, 'visible');
    await esperar(80);
    comp('  -> y al volver, sesion nueva', e.censo.pc.length === 2 && !!c.pc && !c._pauseState);
    limpiar(c); C.__doc.visibilityState = 'visible';
  }

  // ── 17. The loop measured on the tablet: re-inserting the paused card does NOT open a session ──
  seccion('17. connectedCallback de un portero en pausa por inactividad: no arranca');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 150, graciaMs: 50 });
    await c.startWebRTC('unico');
    await esperar(400);
    comp('colgada por inactividad', !!c._pauseState && c._pauseState.phase === 'hung_up');
    const displayBefore = e.censo.pc.length;
    const c2 = nuevaCard(C, { turnMs: 10, idleMs: 150, graciaMs: 50 });   // Home Assistant recreates the element
    c2._registerFullscreenListeners = () => {}; c2._registerVisibilityStreamHandler = () => {}; c2._registerOffscreenStreamHandler = () => {};
    c2.connectedCallback();
    c.connectedCallback && (c._registerFullscreenListeners = () => {}, c._registerVisibilityStreamHandler = () => {}, c._registerOffscreenStreamHandler = () => {}, c.connectedCallback());
    await esperar(200);
    comp('ni la card reinsertada ni una recreada abren sesion', e.censo.pc.length === displayBefore && !!c2._pauseState);
    limpiar(c); limpiar(c2);
  }

  // ── 18. A recent ring wakes up a freshly created card (its "first read") ───────────────────
  seccion('18. Timbrazo de hace 5 s en la primera lectura de una card en pausa: la despierta');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 150, graciaMs: 50 });
    await c.startWebRTC('unico');
    await esperar(400);
    const c2 = nuevaCard(C, { turnMs: 10, idleMs: 150, graciaMs: 50 });
    c2._connInfo = { events_entity: 'event.x_events' };
    c2._hass.states['event.x_events'] = { state: new Date(Date.now() - 5000).toISOString(), attributes: { event_type: 'ring' } };
    c2._restoreSavedPause && c2._restoreSavedPause();
    const displayBefore = e.censo.pc.length;
    c2._updateRingState();
    await esperar(60);
    comp('card nueva en pausa + timbrazo reciente: sesion nueva', e.censo.pc.length === displayBefore + 1 && !c2._pauseState);
    limpiar(c); limpiar(c2);
  }

  // ── 19. Switching Lovelace views removes the card from the DOM: pause, and on return the SAME element
  seccion('19. disconnectedCallback -> live_pause (no bye); connectedCallback -> live_resume, misma sesion');
  {
    const e = construirEntorno({});
    const C = cargarClase(src, e, {});
    const c = nuevaCard(C, { turnMs: 10, idleMs: 999000, graciaMs: 5000 });
    c._registerFullscreenListeners = () => {};
    await c.startWebRTC('unico');
    await esperar(80);
    const pc = c.pc;
    c.disconnectedCallback();
    await esperar(30);
    comp('sacada del DOM: live_pause y la sesion sigue (sin bye)', c._enviados.some((m) => m.type === 'live_pause') && !c._enviados.some((m) => m.type === 'bye') && c.pc === pc);
    c.connectedCallback();
    await esperar(30);
    comp('  -> reinsertada: live_resume en la misma sesion', c._enviados.some((m) => m.type === 'live_resume') && c.pc === pc && e.censo.pc.length === 1);
    limpiar(c);
  }

  return { fallos, total };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  Guarded substitution: the anchor appears exactly once or it ABORTS (CLAUDE.md).
//  Without this, a mutant whose anchor doesn't match would come out identical to the original -- and then the
//  positive control would say "the mutant fails just like the good one... so it passes", silently.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The dist file is saved with Windows line endings and `git show` delivers them with Unix ones. Without
// this, any anchor spanning more than one line NEVER matches against the file on disk -- and
// the only thing that kept that from going unnoticed was `mutar()`'s guard: without it, a mutant
// whose anchor doesn't match comes out IDENTICAL to the original, i.e. a positive control that controls nothing and
// that on top of that says OK.
const normalizarFinales = (t) => t.split('\r\n').join('\n');

function mutar(src, anchorEntity, reemplazo, dayName) {
  const n = src.split(anchorEntity).length - 1;
  if (n !== 1) throw new Error(`mutante "${dayName}": el ancla aparece ${n} veces, no 1 - ABORTADO`);
  return src.replace(anchorEntity, reemplazo);
}

(async () => {
  const arg = process.argv[2];
  const rutaDist = pathmod.join(__dirname, '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');

  if (arg && arg !== '--controles') {
    const r = await ejecutar(fs.readFileSync(arg, 'utf8'), true);
    console.log(r.fallos.length === 0 ? `\nTODO OK (${r.total} comprobaciones)\n` : `\n${r.fallos.length} COMPROBACIONES FALLIDAS\n`);
    process.exit(r.fallos.length === 0 ? 0 : 1);
  }

  // ⚠️ CRLF -> LF ON READ. The dist file is saved with Windows line endings and `git show`
  // delivers them with Unix ones. Without normalizing, mutant anchors spanning more than one
  // line NEVER match -- and `mutar()` loudly aborts, which is what happened the first time. Without
  // `mutar()`'s guard they would have passed as mutants... identical to the original, i.e. positive
  // controls that control nothing.
  const src = normalizarFinales(fs.readFileSync(rutaDist, 'utf8'));
  let mal = 0;

  console.log('\n############ EL FICHERO DE VERDAD ############');
  const bueno = await ejecutar(src, true);
  if (bueno.fallos.length) { console.log(`\n${bueno.fallos.length} FALLOS en el dist actual`); mal += 1; }
  else console.log(`\nTODO OK (${bueno.total} comprobaciones)`);

  console.log('\n############ CONTROLES ############');

  // ── NEGATIVE CONTROL: the file from before the fix has to FAIL ───────────────────────────
  // ⚠️ A COMMIT, NEVER A BRANCH NAME -- and this already cost us once (2026-09-07). The first
  // version said `main:dist/...`, and this repo's working tree is shared by several agents:
  // while the fix was being written, another branch change made the fix's commit end up ON
  // main. The negative control then compared the fixed file against itself, came out green, and
  // said "the old code didn't accumulate connections" -- exactly the opposite verdict from what was measured.
  // A control validated against a moving reference validates nothing. 3983f68 is the last commit
  // BEFORE this fix and it will never move.
  // Since 1.0.0 that build is a FIXTURE (tests/card/fixtures/legacy/card_3983f68.js, translated to
  // today's names by fixtures/make_legacy.js): the card's git history stayed in its old repository.
  // A fixed file is the same guarantee as a commit - it never moves.
  const COMMIT_PREVIO = '3983f68';
  let previo = null;
  try {
    previo = normalizarFinales(fs.readFileSync(pathmod.join(__dirname, 'fixtures', 'legacy', `card_${COMMIT_PREVIO}.js`), 'utf8'));
  } catch (err) {
    console.log(`  WARNING: could not read the ${COMMIT_PREVIO} fixture - the NEGATIVE control did not run.`);
    console.log('         Without it, this bench is NOT validated: it could be saying OK without looking at anything.');
    mal += 1;
  }
  if (previo) {
    // An exception is a failure, never a pass by default.
    let r;
    try { r = await ejecutar(previo, false); } catch (err) { r = { fallos: ['excepcion: ' + err.message], total: 0 }; }
    const veLaFuga = r.fallos.some((f) => f.startsWith('EventSources VIVOS'));
    const veElReloj = r.fallos.some((f) => f.startsWith('hay cuenta atras armada'));
    console.log(`  ${veLaFuga ? 'OK   ' : 'FALLO'} control negativo: el codigo de antes del arreglo ACUMULA conexiones (caso 1)`);
    console.log(`  ${veElReloj ? 'OK   ' : 'FALLO'} control negativo: el codigo de antes del arreglo NO arma el reloj (caso 5)`);
    if (!veLaFuga || !veElReloj) {
      console.log(`         fallos observados en el codigo viejo: ${JSON.stringify(r.fallos)}`);
      mal += 1;
    }
  }

  // ── POSITIVE CONTROLS: each mutant has to break EXACTLY its own case ─────────────────────
  const mutantes = [
    {
      dayName: 'el guardia nunca deja pasar (card en negro para siempre)',
      src: () => mutar(src,
        "    const inFlight = this._startInFlightGen;",
        "    return; const inFlight = this._startInFlightGen;",
        'guardia total'),
      debeFallar: 'hay sesion viva',
    },
    {
      dayName: 'contador de generacion desactivado (_superseded siempre false)',
      src: () => mutar(src,
        '  _superseded(gen) { return gen !== this._connGen; }',
        '  _superseded(gen) { return false; }',
        'sin generacion'),
      debeFallar: 'EventSources VIVOS',
    },
    {
      dayName: 'el toque no rearma (fallo de antes) Y sin re-verificacion del plazo',
      src: () => {
        // ⚠️ A SINGLE-LINE ANCHOR WITH NOT ONE BACKSLASH, and it's not a style choice: the first
        // version of this mutant carried an escaped newline inside the anchor, and that
        // escape collapsed into a real newline when crossing a shell layer -- exactly the
        // landmine CLAUDE.md already had written down. It broke the file visibly, which is the
        // lucky outcome; the dangerous failure mode is the silent one, an anchor that stops matching and a
        // substitution that does nothing without saying so. Hence `mutar()`'s guard.
        let m = mutar(src,
          '      this._armIdleWakeLockTimer(true);',
          '      /* mutante: el toque actualiza la marca pero NO rearma, como antes del arreglo */',
          'toque que no rearma');
        return mutar(m,
          '      if (remainingMs > 0) {',
          '      if (false) {',
          'sin re-verificacion');
      },
      // Phase 0: expiring no longer releases right away, it pauses (live_pause) and the next tap resumes it;
      // case 7 sees this in what was sent to the doorbell.
      debeFallar: '  -> y no se mando ni un live_pause',
    },
    {
      dayName: 'fase 0: el plazo ignora la entidad',
      src: () => mutar(src, "    if (Number.isFinite(v) && v >= 0) return v * 1000;", "    if (false) return v * 1000;", 'sin entidad'),
      debeFallar: 'con la entidad a 0,25 s',
    },
    {
      dayName: 'fase 0: sin veto de llamada',
      src: () => mutar(src, "    return !!(this.talkActive || this._talkHeld || this._talkPending);", "    return false;", 'sin veto'),
      debeFallar: 'con el micro abierto',
    },
    {
      dayName: 'fase 0: al vencer se cuelga sin live_pause ni gracia',
      src: () => mutar(src, "    if (!inCall) this._pauseGraceTimer = setTimeout(() => this._hangUpPaused(), this._idleGraceMs);", "    if (!inCall) { this._hangUpPaused(); return; }", 'sin gracia'),
      debeFallar: 'dentro de la gracia',
    },
    {
      dayName: 'fase 0: la gracia nunca cuelga (la ranura no se libera)',
      src: () => mutar(src, "    this._teardownConnectionObjects();    // sends `bye`", "    // mutante", 'sin bye'),
      debeFallar: 'pasada la gracia',
    },
    {
      dayName: 'fase 0: el timbrazo no despierta',
      src: () => mutar(src, "    if (this._pauseState && document.visibilityState === 'visible') this._resume('ring');", "", 'sin timbre'),
      debeFallar: 'un timbrazo SI',
    },
    {
      dayName: 'fase 0: vuelve el STUN del VPS',
      src: () => mutar(src, "    const iceServers = [];", "    const iceServers = [{ urls: 'stun:46.225.57.138:3478' }];", 'con stun'),
      debeFallar: 'RTCPeerConnection sin iceServers',
    },
    {
      dayName: 'regla de Iñaki: ocultarse vuelve a desmontar en el acto (1.9.0)',
      src: () => mutar(src, "      if (document.visibilityState === 'hidden') {", "      if (document.visibilityState === 'hidden') { this._teardownConnectionObjects(); return;", 'desmonta al ocultar'),
      debeFallar: 'al ocultarse: live_pause enviado',
    },
    {
      dayName: 'regla de Iñaki: con llamada tambien se cuelga',
      src: () => mutar(src, "    if (!inCall) this._pauseGraceTimer = setTimeout(", "    if (true) this._pauseGraceTimer = setTimeout(", 'cuelga con llamada'),
      debeFallar: 'con llamada: live_pause y SIN bye',
    },
    {
      dayName: 'regla de Iñaki: al volver no se recupera el turno',
      src: () => mutar(src, "      if (p.micOpen) this._requestTalkTurn();", "", 'sin turno'),
      debeFallar: '  -> al volver: live_resume y se vuelve a pedir el turno',
    },
    {
      dayName: 'bucle de la tablet: la pausa vuelve a vivir solo en `this`',
      src: () => mutar(src, "    if (!this.config || !PAUSED_BY_DOORBELL[this.config.device_id]) return false;", "    if (!this.config || !this._pauseState) return false;", 'pausa por instancia'),
      debeFallar: 'ni la card reinsertada ni una recreada',
    },
    {
      dayName: 'cambiar de vista vuelve a desmontar (1.9.0)',
      // A ONE-line anchor with no backslashes (CLAUDE.md): the first version carried an escaped
      // newline that a shell layer turned into a real one and broke this file.
      src: () => mutar(src, "    this._pause('hidden');                     // leaving the DOM = pausing, not tearing down", "    this._teardownConnectionObjects();", 'desmonta al salir del DOM'),
      debeFallar: 'sacada del DOM: live_pause',
    },
    {
      dayName: 'timbrazo reciente ignorado en la primera lectura',
      src: () => mutar(src, "        && Date.now() - Date.parse(marker) < RECENT_RING_MS", "        && false", 'sin timbre reciente'),
      debeFallar: 'card nueva en pausa + timbrazo reciente',
    },
  ];

  for (const m of mutantes) {
    let r;
    try { r = await ejecutar(m.src(), false); } catch (err) {
      console.log(`  FALLO control positivo: ${m.dayName} -> ${err.message}`);
      mal += 1;
      continue;
    }
    const rompe = r.fallos.some((f) => f.startsWith(m.debeFallar));
    console.log(`  ${rompe ? 'OK   ' : 'FALLO'} control positivo: "${m.dayName}" rompe el caso que deberia`);
    if (!rompe) {
      console.log(`         se esperaba un fallo que empezara por "${m.debeFallar}"; se observo: ${JSON.stringify(r.fallos)}`);
      mal += 1;
    }
  }

  console.log(mal === 0 ? '\nBANCO VERDE Y VALIDADO POR SUS DOS LADOS\n' : `\n${mal} PROBLEMAS (revisa: un control fallido invalida el banco entero)\n`);
  process.exit(mal === 0 ? 0 : 1);
})().catch((e) => { console.error("EXCEPTION in the bench (not a green run):", e); process.exit(2); });
