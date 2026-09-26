// Isolated simulation of the card's multi-client/quality state, with no browser and no HA.
//
//   node test/sim_multicliente.js dist/ig-doorbell-card.js
//
// Why it exists (2026-07-26): this repo has neither a build nor tests (an explicit decision, see
// CLAUDE.md), and all historical verification has been `node --check` + reading the code. The
// talk turn has too many states (requesting / granted / denied / revoked by the
// doorbell / firmware that doesn't reply) to trust just from reading: this exercises the
// REAL state machine of the dist file (not a copy) against minimal DOM doubles. It does NOT replace
// a browser test with a real doorbell - it doesn't touch WebRTC, SSE, or the relay.
// Loads the real dist/ file, captures the class via customElements.define, and exercises
// handleNativeSignal()/toggleTalk() against minimal DOM doubles.
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2];
const src = fs.readFileSync(path, 'utf8');

let CardClass = null;
function fakeEl() {
  const s = new Set();
  return {
    classList: {
      toggle(c, v) { if (v === undefined) v = !s.has(c); v ? s.add(c) : s.delete(c); },
      add(c) { s.add(c); }, remove(...cs) { cs.forEach((c) => s.delete(c)); },
      contains(c) { return s.has(c); }, _set: s,
    },
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return this._attrs[k]; },
    querySelectorAll() { return []; },
    style: { setProperty() {}, removeProperty() {} }, textContent: '', title: '', innerHTML: '',
  };
}

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  performance: { now: () => Date.now() },
  setTimeout, clearTimeout, setInterval, clearInterval,
  HTMLElement: class {},
  WebSocket: { OPEN: 1 },
  document: { createElement: () => fakeEl(), addEventListener() {}, removeEventListener() {} },
  window: { addEventListener() {}, removeEventListener() {} },
  customElements: {
    get: () => undefined,
    define: (name, cls) => { if (name === 'ig-doorbell-view') CardClass = cls; },
  },
};
sandbox.window.customCards = [];
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
if (!CardClass) { console.error('FAILED: could not capture the class'); process.exit(1); }

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FALLO ${label}`); failures += 1; }
}

function newCard() {
  const c = Object.create(CardClass.prototype);
  c._hass = { language: 'es', states: {} };
  c.config = { device_id: 'abc', unlock_duration: 3 };
  c.sent = [];
  c.sendNativeSignal = (m) => c.sent.push(m);
  c._mark = () => {};
  c._flashes = [];
  c._flashStatusLine = (k) => c._flashes.push(k);
  c._resetStatusLine = () => {};
  c._updateMotionPill = () => {};
  c._setLiveState = (s) => { c._live = s; };
  c._startAudioSendDiagnostics = () => {};
  c._stopAudioSendDiagnostics = () => {};
  // _recordLifeSignal is NOT replaced: case 8 (the life watchdog in audio_only) depends on its
  // real behavior.
  // DOM doubles
  c.micButton = fakeEl();
  c.micIcon = fakeEl();
  c.micLabel = fakeEl();
  // play() and volume have been part of the double since 2026-08-03: §1.10's sound control
  // (_setAudioOn) calls play() on unmuting, because unmuting with no user activation can
  // make the browser PAUSE the element instead of throwing an error.
  c.videoEl = { muted: true, volume: 1, play: () => Promise.resolve() };
  c.volIcon = fakeEl();
  c.sndBtn = fakeEl();
  c.audioPill = fakeEl();
  // These three are born with display:none in render()'s real HTML - reproduce it here, or the
  // simulation would "find" something visible that in the real card is hidden from the start.
  c.clientsPill = fakeEl(); c.clientsPill.style.display = 'none';
  c.clientsCount = fakeEl();
  c.qualityCtl = fakeEl(); c.qualityCtl.style.display = 'none';
  c.qualityBtn = fakeEl();
  c.qualityIcon = fakeEl();
  c.qualityLabel = fakeEl();
  c.qualityMenu = fakeEl();
  // Real getUserMedia doesn't exist here: _startTalk falls into its catch. It's replaced with a double
  // that only marks the logical state, which is what this simulation wants to verify.
  c._startTalk = async () => {
    c.talkActive = true; c._listenOnly = false; c.videoEl.muted = false;
    c._setLiveState('open'); c._paintMicState();
  };
  // Initial state identical to setConfig()'s
  Object.assign(c, {
    talkActive: false, _slot: null, _talkHeld: false, _talkPending: false, _talkTimer: null,
    _talkGrantedAt: 0, _talkUnsupported: false, _listenOnly: false, _talkerSlot: -1,
    _clients: null, _quality: 'auto', _qualityEffective: null, _qualitySupported: null,
    _qualityProbeTimer: null, _qualityProbeAttempts: 0, _qualityMenuOpen: false,
    localAudioStream: null, dummyAudioTrack: { id: 'dummy' }, audioTransceiver: null, pc: {},
  });
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n== 1. Turno concedido (firmware nuevo) ==');
  let c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 1, talker: -1 });
  check('slot aprendido de session_info', c._slot === 1);
  check('contador de clientes = 2', c._clients === 2);
  check('pildora de clientes visible', c.clientsPill.style.display === 'flex');
  check('pildora resaltada con >1 cliente', c.clientsPill.classList.contains('multi'));
  await c.toggleTalk();
  check('talk_request enviado', c.sent.some((m) => m.type === 'talk_request'));
  check('micro AUN cerrado (esperando permiso)', c.talkActive === false);
  check('boton en estado "pidiendo"', c.micButton.classList.contains('requesting'));
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 });
  check('micro abierto tras talk_granted', c.talkActive === true);
  check('turno marcado como nuestro', c._talkHeld === true);
  await c.handleNativeSignal({ type: 'talk_state', slot: 1, talker: 1 });
  check('talk_state con nuestro slot no cierra el micro', c.talkActive === true);

  console.log('\n== 2. Turno denegado -> solo escucha ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: 1 });
  check('boton marcado "ocupado por otro"', c.micButton.classList.contains('busy-other'));
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_denied', slot: 0, reason: 'channel_busy' });
  check('micro NO abierto', c.talkActive === false);
  check('modo solo-escucha activo', c._listenOnly === true);
  check('altavoz desmuteado (se oye al portero)', c.videoEl.muted === false);
  check('aviso claro al usuario', c._flashes.includes('talk_denied_msg'));
  check('boton NO deshabilitado', c.micButton.getAttribute('disabled') === undefined);
  await c.toggleTalk();
  check('segunda pulsacion sale de solo-escucha', c._listenOnly === false);
  check('talk_release enviado al salir', c.sent.some((m) => m.type === 'talk_release'));

  console.log('\n== 3. El portero nos quita el turno (5s de silencio / otro usuario) ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 2, talker: -1 });
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 2 });
  c._talkGrantedAt = 0; // skips the 1.5s anti-race grace period
  await c.handleNativeSignal({ type: 'talk_state', slot: 2, talker: -1 });
  check('micro cerrado al perder el turno', c.talkActive === false);
  check('queda en solo-escucha, no desconectado', c._listenOnly === true);
  check('motivo "silencio" explicado', c._flashes.includes('talk_silence'));
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: -1 });
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  c._talkGrantedAt = 0;
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: 3 });
  check('motivo "otro usuario" explicado', c._flashes.includes('talk_taken'));

  console.log('\n== 4. Gracia anti-carrera (talk_state viejo justo tras el granted) ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: -1 });
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: -1 }); // stale
  check('el micro recien abierto NO se cierra por un talk_state viejo', c.talkActive === true);

  console.log('\n== 5. FIRMWARE ANTIGUO: nadie contesta a talk_request ==');
  c = newCard();
  c._slot = 0;
  await c.toggleTalk();
  check('sigue esperando a los 100ms', c.talkActive === false && c._talkPending === true);
  await wait(3200);
  check('micro abierto igualmente tras 3s', c.talkActive === true);
  check('marcado como firmware sin turno', c._talkUnsupported === true);
  check('avisado una vez al usuario', c._flashes.includes('talk_legacy'));
  check('sin pildora de clientes (nunca llego session_info)', c.clientsPill.style.display === 'none');
  await c.toggleTalk();
  check('apagado limpio', c.talkActive === false);
  const sentBefore = c.sent.length;
  await c.toggleTalk();
  check('2a pulsacion INSTANTANEA (sin nuevo talk_request)',
    c.talkActive === true && !c.sent.slice(sentBefore).some((m) => m.type === 'talk_request'));

  console.log('\n== 6. Calidad: sonda, confirmacion y cambios automaticos ==');
  c = newCard();
  c._slot = 0;
  c._probeQualitySupport();
  check('sonda "auto" enviada al arrancar', c.sent.some((m) => m.type === 'quality' && m.mode === 'auto'));
  check('selector OCULTO hasta confirmar', c.qualityCtl.style.display === 'none');
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'auto', reason: 'user' });
  check('selector visible tras el primer quality_state', c.qualityCtl.style.display === 'block');
  check('marcado como soportado', c._qualitySupported === true);
  c._sendQuality('low');
  check('cambio manual enviado', c.sent.some((m) => m.type === 'quality' && m.mode === 'low'));
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'low', reason: 'user' });
  check('modo efectivo actualizado', c._qualityEffective === 'low');
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'low', reason: 'auto_loss' });
  check('cambio automatico explicado con su motivo', c._flashes.includes('q_auto_loss'));
  await c.handleNativeSignal({ type: 'quality_state', slot: 0, mode: 'audio_only', reason: 'auto_bandwidth' });
  check('motivo de ancho de banda explicado', c._flashes.includes('q_auto_bw'));

  console.log('\n== 7. Calidad con FIRMWARE ANTIGUO (nadie contesta) ==');
  c = newCard();
  c._slot = 0;
  c._probeQualitySupport();
  await wait(8600); // 2 attempts x 4s
  check('reintento antes de rendirse', c.sent.filter((m) => m.type === 'quality').length === 2);
  check('marcado como NO soportado', c._qualitySupported === false);
  check('selector oculto, sin boton muerto', c.qualityCtl.style.display === 'none');
  check('sin molestar al usuario con avisos', c._flashes.length === 0);

  console.log('\n== 8. Vigilante de vida en audio_only (no debe reconectar en bucle) ==');
  c = newCard();
  c._qualityEffective = 'audio_only';
  c._lastLifeSignalAt = 1;
  c._prevPacketsReceived = null;
  let audioPkts = 100;
  c.pc = { getStats: async () => [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 500 },   // frozen on purpose
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: (audioPkts += 50) },
  ] };
  c.pc.getStats = async () => { const arr = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 500 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: (audioPkts += 50) },
  ]; return { forEach: (f) => arr.forEach(f) }; };
  let reconnects = 0;
  c._scheduleReconnect = () => { reconnects += 1; };
  await c._checkLifeWatchdog();
  await c._checkLifeWatchdog();
  check('el audio cuenta como señal de vida en audio_only', reconnects === 0);
  // Same audio_only mode but with audio ALSO stopped: the watchdog must keep doing its
  // job (the relaxation is about which counter is watched, not about no longer watching anything).
  audioPkts = 999; // frozen: (audioPkts += 50) no longer applies because it's reassigned below
  c.pc.getStats = async () => { const arr = [
    { type: 'inbound-rtp', kind: 'video', packetsReceived: 500 },
    { type: 'inbound-rtp', kind: 'audio', packetsReceived: 999 },
  ]; return { forEach: (f) => arr.forEach(f) }; };
  await c._checkLifeWatchdog();                              // takes the baseline
  c._lastLifeSignalAt = c._lastLifeSignalAt - 21000;         // simulates 21s with no progress
  await c._checkLifeWatchdog();
  check('en audio_only con el audio TAMBIEN parado si reconecta', reconnects > 0);

  reconnects = 0;
  c._qualityEffective = 'full';
  c._prevPacketsReceived = null;
  await c._checkLifeWatchdog();                              // takes the baseline (video 500)
  c._lastLifeSignalAt = c._lastLifeSignalAt - 21000;         // simulates 21s with no progress
  await c._checkLifeWatchdog();
  check('con video congelado en modo full SI reconecta', reconnects > 0);

  console.log('\n== 9. Reset por sesion (nada se hereda de la anterior) ==');
  c = newCard();
  c._clients = 3; c._talkerSlot = 2; c._qualitySupported = true; c._quality = 'low';
  c._talkUnsupported = true; c._listenOnly = true;
  c._resetMulticlientState();
  check('contador olvidado', c._clients === null);
  check('turno olvidado', c._talkerSlot === -1 && c._listenOnly === false);
  check('calidad vuelve a auto/sin confirmar', c._quality === 'auto' && c._qualitySupported === null);
  check('se vuelve a sondear el soporte de turno', c._talkUnsupported === false);

  console.log('\n== 10. Mensajes ajenos (fan-out del relay en el camino remoto) ==');
  c = newCard();
  c._slot = 0;
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 }); // we didn't request it
  check('un talk_granted NO solicitado no abre el micro', c.talkActive === false);
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  check('el talk_granted propio si abre el micro', c.talkActive === true);
  const flashesBefore = c._flashes.length;
  await c.handleNativeSignal({ type: 'talk_denied', slot: 1, reason: 'channel_busy' });
  check('un talk_denied ajeno no cierra el micro', c.talkActive === true);
  check('ni molesta con un aviso', c._flashes.length === flashesBefore);

  console.log('\n== 11. Ajustes de contrato del 2026-07-26 ==');
  c = newCard();
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: 1 });
  await c.handleNativeSignal({ type: 'talk_state', slot: 3, talker: 1 });
  check('un talk_state ajeno NO sobrescribe nuestro slot', c._slot === 0);
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 2 }); // granted for ANOTHER slot
  check('talk_granted con slot ajeno no abre el micro', c.talkActive === false);
  check('la peticion propia sigue en vuelo', c._talkPending === true);
  await c.handleNativeSignal({ type: 'talk_denied', slot: 0, reason: 'channel_busy' });
  check('solo escucha tras la denegacion', c._listenOnly === true);
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: -1 });
  check('avisa de que el canal quedo libre', c._flashes.includes('talk_free_retry'));
  check('pero NO reabre el micro solo', c.talkActive === false);
  const flashesAfterHint = c._flashes.length;
  await c.handleNativeSignal({ type: 'talk_state', slot: 0, talker: -1 });
  check('no repite el aviso en cada talk_state', c._flashes.length === flashesAfterHint);

  // ============================================================================================
  // 12. CONTRACT RESOLUTION FROM 2026-07-26, common to card/Android/iOS. These cases exist so
  //     nobody reverts the guards while "simplifying": each one fails if a rule is removed.
  // ============================================================================================
  console.log('\n== 12. Validacion del destinatario del turno (regla comun a los 3 clientes) ==');

  // (a) Own slot UNKNOWN and an OWN request in flight => it's ACCEPTED, knowingly.
  //
  //     THIS CASE FLIPPED SIGN on 2026-07-29 (commit "the four bugs seen on the real
  //     iPhone") and the simulation was left un-updated until 2026-08-03: the two
  //     checks in this block had been red ever since, describing a rule the
  //     code no longer follows, and a suite that's red by default stops warning about anything.
  //
  //     Why it was relaxed, with the full reasoning in _handleTalkGranted(): over the
  //     REMOTE path the offer doesn't carry `slot` (the relay routes by device_id), so the own slot
  //     isn't known until the first session_info. Rejecting there discarded our OWN
  //     talk_granted, the 3s ran out and the card blamed "older firmware" on an up-to-date
  //     doorbell - seen on a real iPhone. And it protected nothing: once the 3s ran out the mic opened
  //     anyway, just later and lying about it.
  c = newCard();
  c._slot = null;
  await c.toggleTalk();
  check('con peticion en vuelo pero slot propio desconocido, se ACEPTA (ver _handleTalkGranted)', c._talkPending === true);
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 });
  check('  -> el micro se abre, apoyandose en que la peticion era nuestra', c.talkActive === true);

  // (b) Validation must NOT be circular: `talk_granted` can't teach us our own
  //     slot (if it could, msg.slot === this._slot would ALWAYS be true and would validate nothing). It's
  //     the bug the Android app had (`_mySlot ??= msg.slot` inside the handler itself).
  //     This rule was NOT relaxed, and it's the one still holding up case (c).
  check('  -> y talk_granted NO nos ha enseñado un slot propio', c._slot === null);
  await c.handleNativeSignal({ type: 'session_info', clients: 2, slot: 0, talker: -1 });
  check('solo session_info (u offer) fija el slot propio', c._slot === 0);

  // (c) With the slot already known, someone else's is rejected and our own is accepted. A fresh card: here the
  //     slot filter is what's checked, not state carried over from the previous case.
  c = newCard();
  c._slot = 0;
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted', slot: 1 });
  check('talk_granted ajeno rechazado con slot propio conocido', c.talkActive === false);
  await c.handleNativeSignal({ type: 'talk_granted', slot: 0 });
  check('talk_granted propio aceptado', c.talkActive === true);

  // (d) Deliberate asymmetry: a message WITHOUT `slot` (intermediate firmware) is accepted relying
  //     only on _talkPending - rejecting it would leave the mic useless against that firmware.
  c = newCard();
  c._slot = 0;
  await c.toggleTalk();
  await c.handleNativeSignal({ type: 'talk_granted' }); // no slot field
  check('mensaje sin slot (firmware intermedio) sigue aceptandose', c.talkActive === true);

  // ============================================================================================
  // 13. IMAGE ROTATION (API_CONTRACT.md §1.9). The bug that motivated all of this was seen on the
  //     real device: the camera is mounted rotated 90° on purpose and the card was rendering the
  //     image sideways, because it never read the `rot` field from session_info.
  // ============================================================================================
  console.log('\n== 13. Giro de la imagen (§1.9) ==');
  function cardConMarco() {
    const card = newCard();
    card.feedWrap = fakeEl();
    card.feedWrap.clientWidth = 400;
    card.feedWrap.clientHeight = 711;
    card.videoEl.style = {};
    card._rot = 0;
    card._rotConfirmed = false;
    card.content = fakeEl();
    return card;
  }

  c = cardConMarco();
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 90 });
  check('rot=90 leido de session_info', c._rot === 90);
  // Since 1.9.7 the frame no longer carries an inline aspect-ratio (_fitToSpace gives it a measured height);
  // the shape reserved with no image is _recallAspect()'s, which comes from the known rotation.
  check('  -> el marco pasa a vertical (forma reservada 9:16)', c._recallAspect() < 1);
  check('  -> el video se gira 90° en sentido horario', /rotate\(90deg\)/.test(c.videoEl.style.transform));
  // With 90/270 width and height have to be SWAPPED, or the rotated image won't cover the space.
  check('  -> caja con ancho y alto intercambiados', c.videoEl.style.width === '711px' && c.videoEl.style.height === '400px');

  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 180 });
  check('rot=180 gira sin intercambiar medidas', c.videoEl.style.transform === 'rotate(180deg)' && c.videoEl.style.width === '');

  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 0 });
  check('rot=0 no gira nada', c.videoEl.style.transform === '' && c._recallAspect() > 1);

  // A weird value gets ignored instead of rendered: rendering it tilted with nothing explaining it is worse
  // than not rotating (same criterion as the firmware, which doesn't store it either).
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1, rot: 45 });
  check('un rot no admitido se ignora', c._rot === 0);

  // Firmware predating §1.9: with no `rot` field, nothing already known gets touched.
  c = cardConMarco();
  c._rot = 90; c._rotConfirmed = true;
  await c.handleNativeSignal({ type: 'session_info', clients: 1, slot: 0, talker: -1 });
  check('session_info sin rot no altera el giro conocido', c._rot === 90);

  // ============================================================================================
  // 14. WATCHING ISN'T LISTENING (API_CONTRACT.md §1.10)
  // ============================================================================================
  console.log('\n== 14. El altavoz del cliente arranca mudo (§1.10) ==');
  c = newCard();
  c._audioOn = false; c._audioOnBeforeMic = false; c.videoEl.muted = true;
  check('arranca mudo', c.videoEl.muted === true && c._audioOn === false);
  c._setAudioOn(true, 'usuario');
  check('el usuario abre el sonido -> suena', c.videoEl.muted === false && c._audioOn === true);
  check('  -> y el icono lo dice', c.volIcon.getAttribute('icon') === 'mdi:volume-high');
  c._setAudioOn(false, 'usuario');
  check('y puede volver a silenciarlo', c.videoEl.muted === true && c.volIcon.getAttribute('icon') === 'mdi:volume-off');

  // Listening and talking are independent axes: on closing the mic, the sound goes back to how it was
  // BEFORE opening it - if you were only watching in silence, you keep watching in silence.
  c = newCard();
  c._audioOn = true; c._audioOnBeforeMic = false; c.talkActive = true; c.videoEl.muted = false;
  await c._stopTalk();
  check('al cerrar el micro el sonido vuelve a como estaba', c._audioOn === false && c.videoEl.muted === true);

  // The doorbell ring is the ONLY reason the sound turns on by itself.
  c = newCard();
  c._audioOn = false; c.videoEl.muted = true;
  c._connInfo = { events_entity: 'binary_sensor.timbre' };  // 1.10.0: no ring_entity in the YAML, the integration provides it
  c._hass.states['binary_sensor.timbre'] = { state: 'off' };
  c._updateRingState();
  check('primera lectura del timbre: no dispara nada', c._audioOn === false);
  c._hass.states['binary_sensor.timbre'] = { state: 'on' };
  c._updateRingState();
  check('alguien llama al timbre -> suena solo', c._audioOn === true && c.videoEl.muted === false);

  // A binary_sensor that was ALREADY 'on' when opening the dashboard isn't a call happening now.
  c = newCard();
  c._audioOn = false; c.videoEl.muted = true;
  c._connInfo = { events_entity: 'binary_sensor.timbre' };  // 1.10.0: no ring_entity in the YAML, the integration provides it
  c._hass.states['binary_sensor.timbre'] = { state: 'on' };
  c._updateRingState();
  check('un timbre que ya estaba sonando al abrir no desmutea', c._audioOn === false);

  // ============================================================================================
  // 15. OPENING THE DOOR REQUIRES CONFIRMATION (API_CONTRACT.md §1.8)
  // ============================================================================================
  console.log('\n== 15. Doble pulsacion para abrir (§1.8) ==');
  function cardConPuerta() {
    const card = newCard();
    card.unlockButton = fakeEl();
    card.unlockIcon = fakeEl();
    card.unlockLabel = fakeEl();
    card._doorArmedAt = 0;
    card._doorArmTimer = null;
    card.isOpen = false;
    card.triggerNativeOpen = () => { card.isOpen = true; };
    return card;
  }

  c = cardConPuerta();
  c._onDoorPress();
  check('la primera pulsacion NO abre', c.isOpen === false);
  check('  -> el boton queda armado y se ve', c._doorArmedAt > 0 && c.unlockButton.classList.contains('confirming'));

  // Rule 2: a FAST double tap doesn't count. A phone in a pocket or a bouncing finger produce
  // exactly that.
  c._onDoorPress();
  check('un doble toque rapido (<300ms) NO abre', c.isOpen === false);

  // Past the minimum, the second tap does open it.
  c._doorArmedAt = Date.now() - 400;
  c._onDoorPress();
  check('la segunda pulsacion, ya separada, abre', c.isOpen === true);
  check('  -> y el boton deja de estar armado (regla 3)', c._doorArmedAt === 0 && !c.unlockButton.classList.contains('confirming'));

  // Rule 1, the one that genuinely protects: confirmation EXPIRES. Without this, an accidental tap
  // leaves the door armed and the next one -equally accidental- opens it.
  c = cardConPuerta();
  c._onDoorPress();
  await new Promise((r) => setTimeout(r, 3200));
  check('la confirmacion caduca sola a los ~3s', c._doorArmedAt === 0 && !c.unlockButton.classList.contains('confirming'));
  c._doorArmedAt = 0;
  c._onDoorPress();
  check('  -> y tras caducar, una pulsacion vuelve a solo armar', c.isOpen === false);

  // ============================================================================================
  // 16. NOTHING HAPPENS IN SILENCE (API_CONTRACT.md §1.0). The door case wasn't a gap: it was
  //     A LIE. The card painted "Open" in green on tapping, before the doorbell
  //     had answered anything - so an open_result that never arrived left the user staring at a
  //     button that said "Open" with the door closed.
  // ============================================================================================
  console.log('\n== 16. Nada ocurre en silencio (§1.0) ==');
  c = cardConPuerta();
  c._doorArmedAt = Date.now() - 400; // already confirmed (§1.8), what's tested here is what happens after
  c.triggerNativeOpen = CardClass.prototype.triggerNativeOpen.bind(c);
  c._onDoorPress();
  check('al mandar el open se ve "abriendo"', c.unlockButton.classList.contains('opening'));
  check('  -> y NO se afirma que este abierta', !c.unlockButton.classList.contains('active-unlock'));
  check('  -> con el aviso a la vista desde el primer instante', c._flashes.includes('door_opening'));
  check('  -> y un plazo armado, para que el indicador TERMINE', !!c._doorWaitTimer);

  // A timeout is a timeout, never an "open".
  c._doorOpenNoAnswer();
  check('sin respuesta: el indicador termina', !c.unlockButton.classList.contains('opening'));
  check('  -> sigue sin afirmarse que se abriera', !c.unlockButton.classList.contains('active-unlock'));
  check('  -> y se dice que no hubo respuesta', c._flashes.includes('door_no_answer'));

  // And with real confirmation from the doorbell, then yes.
  c = cardConPuerta();
  c._doorArmedAt = Date.now() - 400;
  c.triggerNativeOpen = CardClass.prototype.triggerNativeOpen.bind(c);
  c._startDoorCountdown = () => {};
  c._onDoorPress();
  c.handleNativeOpenResult({ status: 'opened' });
  check('con open_result: ahora si "abierta"', c.unlockButton.classList.contains('active-unlock'));
  check('  -> y la espera se ha cerrado', !c.unlockButton.classList.contains('opening') && !c._doorWaitTimer);

  console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} COMPROBACIONES FALLIDAS\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
