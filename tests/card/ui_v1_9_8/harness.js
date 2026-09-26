// Harness for the v1.9.8 real-browser check (Quick reply split button). Copied from
// test/ui_v1_9_7/harness.js (same network/hass doubling rule as every harness in this
// directory: only fetch/EventSource/WebSocket/hass are doubled, never dist/'s own logic) and
// extended with the two new pieces this version needs: `ig_doorbell/get_quick_replies`
// on the websocket bridge, and a way to control it independently of get_connection_info so a
// list-load failure can be tested without also breaking the connection.

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

// -- network double: fails fast, without blocking each test for seconds ----------------------
window.fetch = function () {
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

window.__states = {};
window.__isAdmin = true;
window.tSetHassState = function (entityId, state, attributes) {
  window.__states[entityId] = { entity_id: entityId, state, attributes: attributes || {} };
};
window.tSetAdmin = function (v) { window.__isAdmin = !!v; };
window.__role = 'admin';
window.tSetRole = function (v) { window.__role = v; };
window.__lang = 'es';
window.tSetLang = function (v) { window.__lang = v; };
window.__calledServices = [];
window.__serviceMode = 'ok';   // 'ok' | 'reject' | 'hang' -- covers select_option AND play_sequence
window.__eventsEntity = null;

// Quick reply (v1.9.8): the list ig_doorbell/get_quick_replies would return, and the
// mode it responds with ('ok' | 'reject' | 'hang') -- kept separate from get_connection_info on
// purpose, to be able to test "connection fine, list fails" without touching the former.
window.__quickReplies = [];
window.__qrMode = 'ok';
window.tSetQuickReplies = function (list) { window.__quickReplies = list; };
window.tSetQrMode = function (v) { window.__qrMode = v; };


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
    language: window.__lang,
    callApi: async () => { throw { status_code: 404 }; },
    user: { is_admin: window.__isAdmin },
    get states() { return window.__states; },
    formatEntityState: (stateObj, opt) => opt,
    callService: (domain, service, data) => {
      window.__calledServices.push({ domain, service, data });
      log(`callService(${domain}.${service}, ${JSON.stringify(data)}) modo=${window.__serviceMode}`);
      if (window.__serviceMode === 'reject') return Promise.reject(new Error('That sequence does not exist on the doorbell.'));
      if (window.__serviceMode === 'hang') return new Promise((res) => { window.__releaseService = res; });
      return Promise.resolve();
    },
    connection: {
      sendMessagePromise: async (msg) => {
        log(`sendMessagePromise(${msg.type})`);
        if (msg.type === 'ig_doorbell/get_connection_info') {
          return { device_id: 'test-device', role: window.__role, live_timeout_entity: null, events_entity: window.__eventsEntity };
        }
        if (msg.type === 'ig_doorbell/get_quick_replies') {
          if (window.__qrMode === 'reject') throw new Error('unreachable');
          if (window.__qrMode === 'hang') return new Promise(() => {});
          return { quick_replies: window.__quickReplies };
        }
        if (msg.type === 'history/history_during_period') return { [msg.entity_ids[0]]: [] };
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
window.tRefreshHass = function (id) {
  window.__cards[id].hass = window.__cards[id]._hass;
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
