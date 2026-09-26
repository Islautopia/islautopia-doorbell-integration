// Harness for the REAL BROWSER REVIEW of the v1.9.2 changes (REC, relocated speaker,
// mode chip, and the native-fullscreen safety class), without replacing anything in the
// dist/ file itself -- same principle as test/idle_release_network: only
// fetch/EventSource/WebSocket and the hass.connection.sendMessagePromise bridge get doubled, the NETWORK, never the
// card's logic.
//
// Unlike test/sim_multicliente.js (which builds a minimal instance by hand, with no
// real document.createElement or innerHTML), this harness DOES call setConfig()/render() for
// real, with a real DOM -- it's the only thing that lets you check that the REC button appears/
// disappears on the real page, that clicking the mode chip calls select.select_option, and
// that fullscreen leaves the CSS classes _applyFullscreenUI() expects.

window.TESTLOG = [];
function log(msg) {
  const line = `[t+${(performance.now() - window.__t0).toFixed(0)}ms] ${msg}`;
  window.TESTLOG.push(line);
  console.log('TESTLOG ' + line);
}
window.__t0 = performance.now();

// Before 1.10.0 the whole card was one element under the CARD tag; a control run with an old
// build (CARD_FILE=tests/card/fixtures/legacy/...) needs that fallback, or it goes red on a
// missing element instead of on the checks.
const CARD_ELEMENT_TAG = customElements.get('ig-doorbell-view') ? 'ig-doorbell-view' : 'ig-doorbell-card';
const CardClass = customElements.get(CARD_ELEMENT_TAG);
if (!CardClass) log('ERROR: ig-doorbell-card no se registro');

// ── Network double: fails fast, without blocking each test for seconds ─────────────────────
window.fetch = function (url) {
  return new Promise((_, reject) => setTimeout(() => reject(new TypeError('network error (doblado)')), 10));
};
class FakeEventSource {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; }
  close() {}
}
window.EventSource = FakeEventSource;
class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.onopen = null; this.onerror = null; this.onmessage = null; this.onclose = null; }
  send() {}
  close() { this.readyState = 3; }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
window.WebSocket = FakeWebSocket;

// ── Doubled hass, with what v1.9.2 genuinely needs: states/user/callService/
//    formatEntityState (for the mode chip) plus the signaling bridge the sibling harness
//    already doubled. `tSetHassState`/`tSetAdmin` move it during the test. ─────────────────
window.__states = {};
window.__isAdmin = true;
window.tSetHassState = function (entityId, state, attributes) {
  window.__states[entityId] = { entity_id: entityId, state, attributes: attributes || {} };
};
// (1.9.4, Iñaki 2026-09-25) REC NO LONGER depends on `hass.user.is_admin` -- that's the user of THIS
// Home Assistant panel, and the real change was precisely stopping looking at it (the "Kiosko"
// tablet, not an HA admin, but the integration paired as the doorbell's administrator). `__isAdmin`
// is kept only to demonstrate that independence (driver.js's test 3 leaves it as `false` and
// checks that REC stays visible if the doorbell's ROLE is admin). What genuinely governs it is
// `__role` -- the same value the integration would expose in `get_connection_info.role`
// (websocket_api.py, resolved from `/api/whoami?token=`, API_CONTRACT.md §3.3-ter).
window.tSetAdmin = function (v) { window.__isAdmin = !!v; };
window.__role = 'admin';
window.tSetRole = function (v) { window.__role = v; };
window.__calledServices = [];
window.__serviceMode = 'ok';
window.__eventsEntity = null;
window.__history = [];
window.__historyCalls = [];


// (1.10.0) The card no longer accepts entities in the YAML: it finds them in HA's registries
// (hass.devices + hass.entities, ig_doorbell platform, by translation_key). This
// harness translates the old options the drivers still use (rec_entity, mode_entity...)
// into the card's doorbell registry entries, which is exactly what the integration publishes.
window.__devices = {};
window.__entities = {};
window.tRegistry = function (deviceId, config) {
  const ha = 'ha-' + deviceId;
  const devices = Object.assign({}, window.__devices);
  const entities = Object.assign({}, window.__entities);
  devices[ha] = { id: ha, name: 'Portero ' + deviceId, identifiers: [['ig_doorbell', deviceId]] };
  const map = { rec_entity: 'rec', mode_entity: 'mode', motion_entity: 'visitor', ring_entity: 'events' };
  for (const k of Object.keys(map)) {
    if (config && config[k]) entities[config[k]] = { entity_id: config[k], device_id: ha, platform: 'ig_doorbell', translation_key: map[k] };
  }
  window.__devices = devices;       // NEW objects: the card caches by identity
  window.__entities = entities;
};

function makeHass() {
  return {
    get devices() { return window.__devices; },
    get entities() { return window.__entities; },
    language: 'es',
    callApi: async () => { throw { status_code: 404 }; },
    user: { is_admin: window.__isAdmin },
    get states() { return window.__states; },
    formatEntityState: (stateObj, opt) => opt, // simple fallback: the raw label
    // 1.9.7: the service call can be left hanging ('hang', to see the optimistic chip pending),
    // rejected ('reject', like a HomeAssistantError from integration 0.7.4) or accepted ('ok').
    callService: (domain, service, data) => {
      window.__calledServices.push({ domain, service, data });
      log(`callService(${domain}.${service}, ${JSON.stringify(data)}) modo=${window.__serviceMode}`);
      if (window.__serviceMode === 'reject') return Promise.reject(new Error('The doorbell did not apply the mode'));
      if (window.__serviceMode === 'hang') return new Promise((res) => { window.__releaseService = res; });
      return Promise.resolve();
    },
    connection: {
      sendMessagePromise: async (msg) => {
        log(`sendMessagePromise(${msg.type})`);
        if (msg.type === 'ig_doorbell/get_connection_info') {
          // Genuinely resolves (instead of `not_found`) because REC depends on `.role` in the
          // response -- see _updateRecButton() in dist/. The rest of the fields don't need to
          // be real for these UI tests (signaling is never completed).
          return { device_id: 'test-device', role: window.__role, live_timeout_entity: null, events_entity: window.__eventsEntity };
        }
        if (msg.type === 'history/history_during_period') {
          window.__historyCalls.push(msg);
          const a = Date.parse(msg.start_time), b = Date.parse(msg.end_time);
          const rows = window.__history.filter((e) => e.ts >= a && e.ts <= b).map((e) => ({
            s: new Date(e.ts).toISOString(), a: Object.assign({ event_type: e.ev, ts: Math.floor(e.ts / 1000) }, e.a || {}), lu: e.ts / 1000,
          }));
          return { [msg.entity_ids[0]]: rows };
        }
        throw new Error('mensaje no soportado por el doble de hass: ' + msg.type);
      },
    },
  };
}

window.__cards = {};
window.tCreateCard = function (id, config) {
  const card = document.createElement(CARD_ELEMENT_TAG);
  card.__tid = id;
  card.hass = makeHass();
  window.tRegistry((config && config.device_id) || ('test-device-' + id), config);
  card.setConfig(Object.assign({ device_id: 'test-device-' + id }, config));
  window.__cards[id] = card;
  log(`tCreateCard(${id}) config=${JSON.stringify(config)}`);
  return id;
};
window.tAttach = function (id) {
  document.getElementById('host').appendChild(window.__cards[id]);
  log(`tAttach(${id})`);
};
// Repaints whatever's bound to hass (equivalent to Home Assistant reassigning `hass` with a new tick).
window.tRefreshHass = function (id) {
  window.__cards[id].hass = window.__cards[id]._hass; // the setter fires _updateHassBoundUI()
};
window.tClick = function (id, selector) {
  const el = window.__cards[id].querySelector(selector);
  if (!el) { log(`tClick(${id}, ${selector}) -- NO ENCONTRADO`); return false; }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  log(`tClick(${id}, ${selector})`);
  return true;
};
window.tRect = function (id, selector) {
  const el = selector ? window.__cards[id].querySelector(selector) : window.__cards[id];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

log('harness listo');
