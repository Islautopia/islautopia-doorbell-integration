# Plan: Home Assistant at parity with the apps

*Written 2026-09-25. Planning document — nothing here is implemented yet.*

> **The goal (Iñaki, 2026-09-25):** the integration is "almost marginal" today. **Integration + card together
> must give everything the iOS and Android apps give.**

This plan answers three questions: (1) which app features go into Home Assistant and which do not;
(2) which go in the card and which in the integration; (3) whether the integration can create a `camera`
entity. Then effort, phases, risks and the decisions only Iñaki can take.

**References used** (read-only): integration `main` @ `25a2eac` (0.6.2); card `main` @ `7854738` (1.8.1);
iOS `grabaciones-v2` @ `122e275` (0.80.36); Android `coche-en-la-app` @ `9d3c539` (0.79.6);
`API_CONTRACT.md` as of firmware 0.94–0.98.

**How to read the claims.** Every statement is tagged:

- **[V-code]** — verified by reading the code or the contract at the commits above (not executed).
- **[V-doc]** — verified in official Home Assistant documentation or repositories, with URL and fetch date.
- **[S]** — supposed / reasoned, not measured. Each one names what would confirm it.

---

## 0. The rules this plan obeys

These are decisions already taken. The plan does not reopen them.

1. **The card shows; the integration exposes** (Iñaki, 2026-08-31). Every reading or control becomes an
   **entity** of the integration, usable by automations, any dashboard and voice. The card consumes entities
   and only adds what an entity cannot give: the live call (video + two-way audio + talk turn), the
   door-open interaction and the per-viewer experience. Nothing is duplicated in the card.
2. **Home Assistant is a local client, like an app at home** (Iñaki, 2026-09-25). It may do what an app on
   the home network may do, including the routes the doorbell accepts only from the LAN. How a person
   reaches their own Home Assistant is not this project's concern and is not analysed here.
3. **The integration talks to the doorbell only over direct IP on the LAN — never through the VPS, not even
   as a fallback or an attempt** (Iñaki, 2026-09-25). No relay, no API tunnel, no cloud catalog, no
   cloud-served DNS. If there is no direct IP connectivity, the configuration is not viable and setup
   says so.
4. **Security settings belong to the doorbell**, not to a client (2026-09-23). HA reads and writes the same
   `save_states` fields the apps do; it never keeps its own copy.
5. **Admin writes, anyone reads** (§1.16-bis). Every writable entity fails loudly (`HomeAssistantError`)
   when the pairing is not admin — never a silent no-op.

### What stays out even for a local client, and why (the technical reasons)

Being local removes the network argument, not these three:

- **Secrets cannot be entity state.** HA writes every state change to its recorder database and shows it in
  history and the logbook; automation traces keep service data. A WiFi password, a door code, the CarPlay
  code or an account password as a `text` entity would be persisted in clear in HA's database. Where HA
  needs to write a secret at all, the place is a **config/options flow** (as the pairing password already
  is), never an entity.
- **Irreversible actions need the confirmation the apps enforce.** Factory reset (confirm by typing the
  doorbell's name, §1.17) and formatting the SD card have no equivalent in the entity model: a `button` is
  one tap — or one automation — away.
- **Editor-grade flows are not entities.** Framing calibration from a photo (§1.9-bis), the sequence
  editor, fingerprint enrolment, recording a quick-reply clip: there is no entity type that can express
  them, and HA's own automations are the native equivalent of most of them.

---

## 1. What exists today

### 1.1 Integration (0.6.2) [V-code]

| piece | what it does | state |
|---|---|---|
| `event.<doorbell>_eventos` | all §1.16 events from the webhook, 18 known types | works; **no call events** (6, 7, 8 come from the relay, which the webhook does not see) |
| `binary_sensor` visitor / package | visitor auto-off after 30 s; package on/off by `package`/`package_gone` | works |
| `binary_sensor` panel / reader | peripheral presence from `get_states` | works |
| `button` open door | `GET /open`; hidden when `door_m=2` | works; **no double confirmation** (see §6, Dec-4) |
| `select` mode | Normal / Away / DND / Custom via `save_states` | works |
| `sensor` viewers, firmware version, panel firmware | from `get_states` / `firmware_info` | works; **entity names hard-coded in Spanish** (`sensor.py`, `select.py`, `binary_sensor.py`) instead of English + `translation_key` |
| `media_source` recordings | browse + play in HA's media browser | works on LAN; **leaks the credential to the browser** (below) |
| webhook | doorbell → HA events and `hass_action`, returns the `igd` mark | works |
| options flow | picks the ≤ 24 HA entities the doorbell may act on; re-pair | works |
| signalling proxy | card's local WebRTC signalling relayed through HA | works |
| WebSocket commands | `get_connection_info`, `get_turn_credentials`, `get_local_signal_url` | see VPS list |
| coordinator | polls `get_states` every 30 s | works |

### 1.2 Card (1.8.1) [V-code]

Live video over its own WebRTC, speaker muted by default + volume memory, talk with turn-taking
(`talk_request`/`talk_release`), door open with double confirmation and real `open_result`, per-viewer
quality (Auto/High/Low/Audio only), viewer pill, fullscreen with in-video buttons, rotation, idle release for
wall panels, mode chips (consumes the `select`), motion badge (consumes a `binary_sensor`), sound on ring
(consumes the `event`), 9 languages.

Missing against the apps: decline / hang up a ring as a call, quick replies during a call, the REC button,
the audience list (who is talking). Deployment has no cache-busting on the manual path (known since
2026-07-12).

### 1.3 Every path from the integration or the card to the VPS — to remove in Phase 0 [V-code]

Rule 3 says none of these may exist. File and line at integration `25a2eac` / card `7854738`:

| # | where | what | action |
|---|---|---|---|
| 1 | `custom_components/islautopia_doorbell/api.py:229-260` (`RELAY_HOST` import at `:25`) | `GET https://relay…/device/<id>/app_turn_credentials` | **remove** |
| 2 | `websocket_api.py:49` and `:164-208` | `islautopia_doorbell/get_turn_credentials` WS command (calls #1) | **remove** |
| 3 | `websocket_api.py:120` (`:39` import) | `get_connection_info` returns `relay_ws_url` **and the pairing credential** to the browser | **remove both fields**; the proxy (`signal_proxy.py:133,199`) already adds the token server-side |
| 4 | `const.py:82` | `RELAY_HOST` | **remove** |
| 5 | `net.py:1-36, 78-116` | resolver: LAN address first, **then public DNS** for `<id>.doorbell.islautopia.com` — a record our cloud maintains (§3.1) | **remove the DNS fallback**; keep the LAN mapping (stored IP → mDNS `_igdoorbell._tcp`, already used by zeroconf) with certificate validated against the hostname |
| 6 | `media_source.py:200,221` → `api.py:145-154` | thumbnail and playback URLs point the **browser** at the doorbell's public hostname with `?token=<credential>` | **proxy through an HA view with signed paths**: removes the public-DNS dependency and stops handing the credential to every HA user's browser |
| 7 | card `dist/islautopia-intercom-card.js:3600-3620` | fallback to relay WebSocket signalling | **remove** |
| 8 | card `:3337` and around | fallback to direct signalling at the public hostname (for integrations older than the proxy) | **remove** |
| 9 | card `:3161-3175` | hard-coded `stun:46.225.57.138:3478` + TURN from #2 | **remove**; on the LAN the doorbell's host candidate is enough (measured 2026-07-29: host↔host, 2 ms RTT, `signal_proxy.py` docstring) |

**Consequence of #1, #2, #9, stated once:** the card's live call works wherever the browser can reach the
doorbell's LAN address, and nowhere else. That follows from rule 3 and is accepted by it.

### 1.4 Setup must fail clearly without direct IP (new requirement)

Today `config_flow` checks `GET /api/device_id` on port 80 and then logs in against the hostname, which can
still fall back to DNS (#5). Required:

1. Reach the doorbell at its **LAN address** on port 80 (`/api/device_id`) **and** 8443 (TLS, certificate
   validated against `<device_id>.doorbell.islautopia.com`), with no DNS fallback.
2. If either fails: abort with one message — *"Home Assistant must be on the same network as the doorbell
   (or a routed VLAN). No direct connection to <IP> was possible."* — and **create nothing**: no entry, no
   pairing on the doorbell (if `pair_app` succeeded and a later step fails, `unpair_app` it).
3. After pairing, verify the other direction: configure the webhook, read `GET /api/hass`, and report if the
   doorbell cannot deliver (`fallos` rising / no `igd` mark).
4. Known limit, already in §4 of the contract: a doorbell that never had internet has no public certificate
   and cannot `pair_app` over 8443. It cannot be added to HA today. Not new, but it now becomes visible.

---

## 2. Inventory of app features, and where each goes

Grouped as the apps group them. **HA?** = Yes / No / Cond. (with conditions). **Where** = entity type
(integration) or **card**. **Today** = done / partial / missing. Routes are from the contract.

### A. Live view and call

| # | feature (both apps) | HA? | where | today | note |
|---|---|---|---|---|---|
| A1 | Live video | Yes | **card** (call) + `camera` (passive, §3) | card done | |
| A2 | Listen; speaker muted by default; volume | Yes | card | done | per-viewer by nature |
| A3 | Talk with talk turn | Yes | **card only** | done | a HA `camera` cannot talk (§3.4) |
| A4 | Open the door | Yes | `button` + card | done | `button` has no §1.8 confirmation (Dec-4) |
| A5 | Per-viewer quality | Yes | card only | done | belongs to one session; nobody else could use an entity for it |
| A6 | Viewer count | Yes | `sensor` + card pill | done | |
| A7 | Who is watching / talking (audience) | Cond. | card | missing | only visible inside a signalling session |
| A8 | Ring arrives as a call (take / decline) | Yes | card: ring banner + **decline** (`call_declined`); `event` for automations | partial | HA push notifications are HA's own, built on the `event` |
| A9 | Hang up | Yes | card (`bye`) | partial | closing the view already hangs up |
| A10 | Quick replies (play a clip to the street) | Yes | card button during call + `select` + `button` (or an action) for automations | missing | needs an HTTP route (F-1) |
| A11 | Play a sequence | Yes | action `islautopia_doorbell.play_sequence` | missing | needs an HTTP route (F-1) |
| A12 | Manual recording (REC, admin) | Yes | `switch` "Recording", state from `rec_state` | missing | today only a signalling message (§1.4-quater); F-1 |
| A13 | Fullscreen, rotation, in-video buttons | Yes | card | done | |
| A14 | WebRTC diagnostics overlay (English) | Cond. | card, behind a flag | partial | |
| A15 | Disguised voice | No | — | — | switched off in firmware and iOS; revisit when switched on |
| A16 | Car screens (CarPlay / Android Auto) | No | — | — | a phone-in-car feature; the setting behind it is E5 |

### B. Events and notices

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| B1 | Event catalog (§1.16) | Yes | `event` | partial | 18 types; call events 6/7/8 and 11/12 are generated by the relay → **the doorbell must emit 6/7/8 on the webhook** (F-2) |
| B2 | Visitor / package | Yes | `binary_sensor` ×2 | done | |
| B3 | Ringing / call in progress | Yes | `binary_sensor` | missing | from the ring event + `GET /api/call_status` |
| B4 | Per-phone notification preferences | No | — | — | per-phone, stored in the VPS; HA's equivalent is automations on B1 |
| B5 | The bell (unread list) | No | — | — | HA's logbook already does it for an `event` |

### C. Recordings

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| C1 | List, thumbnails, play | Yes | `media_source` | done (LAN) | fix VPS #6; playback needs an admin pairing |
| C2 | Delete a recording (admin) | Cond. | action `delete_recording` | missing | low priority |
| C3 | SD card status (size, free, broken, index) | Yes | `sensor` ×3–4 (diagnostic) | missing | `GET /api/storage_info` |
| C4 | Format the SD card | No | — | — | irreversible (§0) |
| C5 | Recording playback over WebRTC, seek | No | — | — | `media_source` over HTTP covers it |

### D. Modes

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| D1 | Current mode | Yes | `select` | done | |
| D2 | Why it is in that mode (manual / rule) | Yes | `sensor` or attribute of D1 | missing | §1.12-bis |
| D3 | "When the mode changes" rules | Cond. | read-only `sensor` summary; optional `switch` per rule | missing | editing stays in the apps: nested editor, no entity type fits |
| D4 | Sequences, actions, clips, voices editor | No | — | — | editor-grade (§0); HA automations are the native equivalent |
| D5 | Which HA entities the doorbell may act on | Yes | options flow | done | |

### E. Keys, users and access

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| E1 | Users: list | Yes | `sensor` (count + attributes) | missing | |
| E2 | Users: invite, revoke | No | — | — | invite produces a code for a person (a secret, §0) |
| E3 | Paired apps: list / unpair | Cond. | list: `sensor`; unpair: no | missing | unpair from HA could cut HA's own pairing; stays in apps |
| E4 | Keys: list with validity | Yes | `sensor` | missing | |
| E5 | Keys: create with a code, fingerprint enrolment | No | — | — | secret / physical flow (§0) |
| E6 | Key events (denied, locked) | Yes | `event` | done | |
| E7 | Opening from the car: allowed (`car_open`) | Yes | `switch` (admin) | missing | local client may write it (rule 2) |
| E8 | CarPlay / car code (`car_code`) | Cond. | `binary_sensor` "code set" only | missing | the code itself is a secret (§0) |
| E9 | Street panel / fingerprint reader present | Yes | `binary_sensor` ×2 | done | |

### F. Advanced — image, detection, door

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| F1 | Brightness, contrast, saturation, hue | Yes | `number` ×4 (config) | missing | `save_states` |
| F2 | Auto white balance, night mode | Yes | `switch` ×2 | missing | |
| F3 | Flip V / H | Cond. | **read-only** | missing | hot change destroys colour until reboot (CLAUDE.md landmine); an automation toggling it would be harmful |
| F4 | Exposure auto/manual, EV, manual exposure/gain | Yes | `select` + `number` | missing | `/api/img_settings` (iOS has it; Android to check) |
| F5 | Timestamp on/off, position | Yes | `switch` + `select` | missing | |
| F6 | Framing calibration from a photo | No | — | — | editor-grade (§0) |
| F7 | Detection per class: on/off, threshold | Yes | `switch` + `number` per class | missing | `/api/detect_config` |
| F8 | `aimin` distance filter | No | — | — | filters nothing since 2026-09-04 (§1.14-bis): a control that does nothing |
| F9 | Lock type (`door_m`), HA entity (`ha_e`) | Yes | `select`; `ha_e` in options flow | missing | |
| F10 | Unlock time (`dur`) | Yes | `number` | missing | |
| F11 | Mic gain | Yes | `number` | missing | |

### G. Connectivity and streams

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| G1 | WiFi SSID, IP | Yes | `sensor` (diagnostic) | missing | |
| G2 | Change WiFi | No | — | — | password is a secret, and it reboots the doorbell (§0) |
| G3 | RTSP on/off | Cond. | driven by the `camera` decision (decision Dec-1, §6) | missing | |
| G4 | Main / sub stream fps, kbps, CBR | Yes | `number`/`switch`, config, **disabled by default** | missing | |
| G5 | Device name | Yes | `text` | missing | |
| G6 | Certificate / key upload | No | — | — | installation secrets |
| G7 | Doorbell language and time zone (§1.13) | Cond. | `select` | missing | confirm the write route first |

### H. Firmware and system

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| H1 | Firmware version, check, install, progress | Yes | `update` | partial (version sensor) | catalog is in the VPS → §4 |
| H2 | Street panel firmware + update | Yes | `update` | partial (sensor) | `/api/panel_ota` is local |
| H3 | Reboot | Yes | `button` (config) | missing | |
| H4 | Factory reset | No | — | — | irreversible, typed confirmation, and it wipes HA's own pairing |
| H5 | Memory, boot reason, uptime | Yes | `sensor` (diagnostic, disabled by default) | missing | `/api/mem_stats`, `/api/debug/boot` |
| H6 | About: versions, hardware | Yes | device registry `sw_version`/`hw_version` | partial | |

### I. Account and this phone

| # | feature | HA? | where | today | note |
|---|---|---|---|---|---|
| I1 | Pair a doorbell | Yes | config flow | done | + requirement §1.4 |
| I2 | Provision a new doorbell (WiFi) | No | — | — | out-of-box flow over the doorbell's AP |
| I3 | Accept an invitation | No | — | — | a person's account flow |
| I4 | My role on this doorbell | Yes | `sensor` (diagnostic) | missing | explains why writes fail |
| I5 | Change password | No | — | — | secret (§0) |
| I6 | App language, auto-answer, this phone's sounds | No | — | — | per-phone preferences, not the doorbell's |

### Count

**70 features inventoried: 52 go into HA (43 Yes, 9 conditional), 18 do not.** Of the 52: **31 are
missing, 7 partial, 14 done.** The 18 "No" rows, by reason: a secret (5), irreversible (2), editor-grade or
physical flow (4), per-phone preference or phone feature (3), a control that does nothing or is switched off
(2), already covered natively by HA (2).

**Split, in two lines:** the integration carries ~45 entities [S] of 10 types (`camera`, `update` ×2,
`switch`, `select`, `number`, `sensor`, `binary_sensor`, `button`, `event`, `text`) plus 3 actions and the
media source; the card carries only the call — live WebRTC video, listen/talk with the turn, door open with
confirmation, decline/hang-up, quick replies during the call, per-viewer quality.

---

## 3. The `camera` entity

### 3.1 What Home Assistant offers today [V-doc, fetched 2026-09-25]

- **Camera entity API** — `CameraEntityFeature.STREAM` and `ON_OFF`; `async_camera_image()` returns a still;
  `stream_source()` returns a URL that HA streams (HLS via the `stream` component by default); native WebRTC
  via `async_handle_async_webrtc_offer()`, `async_on_webrtc_candidate()`, `close_webrtc_session()`; native
  WebRTC cameras "do not use the `stream` component and do not support recording".
  <https://developers.home-assistant.io/docs/core/entity/camera/>
- **go2rtc is built in** since 2024.11 and set up automatically with `default_config` on HA OS and Container;
  it "provides a WebRTC proxy for all your cameras", i.e. an RTSP `stream_source` is delivered to the
  browser as WebRTC. <https://www.home-assistant.io/integrations/go2rtc/>,
  <https://www.home-assistant.io/blog/2024/11/06/release-202411/>
- **Two-way audio is not in HA core.** PR *"Add two way audio support"* (adds a `TWO_WAY_AUDIO` camera
  feature and a talk button) is still a **draft, not merged**; the core team will not ship it until local
  HTTPS is solved, because browsers only give the microphone to secure origins.
  <https://github.com/home-assistant/core/pull/148282>

### 3.2 The three possible paths

**A. Snapshot-only camera** (`async_camera_image` → `GET /api/snapshot`, no `STREAM`).
Cheapest and immediately useful: a picture in notifications, picture cards, `camera.snapshot`, and in
Assist/voice devices that show cameras. Doorbell cost: one JPEG per request — **no signalling slot, no video
destination**. [S] HA's frontend refreshes camera stills periodically while visible (≈10 s); the integration
must cache and rate-limit (e.g. one real fetch per 5 s shared by all viewers, and none while a call is live,
§1.0-quinquies). *Confirm by measuring `/api/snapshot` cost on the Waveshare during a call.*

**B. Streaming camera over RTSP via go2rtc** (`stream_source = rtsp://token:<credential>@<LAN IP>:554/stream`).
- Doorbell cost: **one RTSP connection, whatever the number of HA viewers** [S — go2rtc's design is one
  upstream pull fanned out to many viewers; confirm with two browsers and `RTSP_TX` in the log]. RTSP viewers
  **do not use** the 8 signalling slots or the 4 video destinations (RTSP is not counted, §1.2) [V-code].
- Audio: RTSP carries PCMA (fixed in 0.75.2), so **listening works; talking does not** — no backchannel,
  and HA has no talk button anyway (3.1).
- Conflicts [V-code, contract §1.4]: **RTSP accepts exactly one connection** and a new one evicts the old
  (0.74.5, Iñaki: *RTSP is the hook for ONE recorder, e.g. Frigate*). HA would take that one slot.
  RTSP is off by default (`rtsp_en=0`) and travels unencrypted on the LAN (Basic auth with the pairing
  credential; no RTSPS) — the same LAN trust the contract already accepts.
- Latency [S]: RTSP→go2rtc→WebRTC should be well under a second; *measure against the card's direct path.*

**C. Native WebRTC camera** (`async_handle_async_webrtc_offer`, HA brokering our signalling).
**Not viable without a large firmware change.** HA's model has the **browser make the offer** and the
camera answer; our doorbell is ICE-Lite and **always the offerer — it never processes an offer** [V-code,
card investigation 2026-07-12, JSEP §5.10]. Making the doorbell an answerer means changing the ICE/DTLS roles
of our own stack. And even then each HA viewer would cost a signalling slot **and** one of the 4 video
destinations — exactly what B avoids.

### 3.3 Recommendation

1. **Phase 1: path A** (snapshot camera). No firmware change, no decision needed, big everyday value.
2. **Phase 3: path B**, after Iñaki decides the RTSP slot (decision Dec-1, §6). Suggested answer: firmware allows **two**
   RTSP connections — one reserved for the integration (identified by its credential), one for a third-party
   recorder — instead of one. [S] cost: one more RTSP packetiser on the P4; *measure CPU and fps with both
   connected.*
3. **Not C.**
4. **Talking stays in the card.** A `camera` entity cannot talk in HA today (3.1), and even when the PR lands
   it would need an RTSP backchannel the doorbell does not have.

**A consequence worth taking:** with B, a wall panel can show the street 24/7 from the `camera` entity
and open the card's own WebRTC session only on a ring or a touch. Today a wall panel holds **one of the four
video destinations permanently**. [S] *The switch between the two views must be measured on the Galaxy Tab
before promising it.*

### 3.4 Privacy note

HA offers `camera.record` and `camera.snapshot`, which write files to HA's disk. That is the owner's own
machine in the house and their own choice, but the product sentence today is "recordings live on the SD card
and nowhere else". Decision Dec-3 in §6.

---

## 4. The firmware `update` entity: the doorbell checks, HA asks the doorbell

**Decided by Iñaki (2026-09-25):** *"it is right that the doorbell itself checks whether a firmware is
available."* The HA `update` entity reads **from the doorbell, never from the VPS**, and installing is also
asked **of the doorbell**.

Why it fits: the catalog lives in the VPS (`GET /device/<id>/firmware/latest`, today with app auth,
§1.2-sexies) and the **doorbell already downloads the binary itself** with its own secret. The only missing
piece is that the doorbell asks the catalog on its own and tells the LAN.

**Prerequisite work (firmware + VPS), before the entity:**

- **Firmware — reading.** A field in `GET /api/firmware_info` (preferred: it already carries versions and
  hardware; `get_states` is polled every 30 s and should stay small), e.g.
  `"available": {"status": "update_available", "version": "0.99.0", "notes": "...", "checked_at": ...}`.
  The doorbell fills it by asking the VPS with its `device_secret` (at boot and every few hours), caches it,
  and keeps the **four distinguishable states** of §1.2-sexies — `up_to_date`, `update_available`,
  `unknown_hardware` — plus **`not_checked`** when the doorbell itself could not reach the VPS. Never an empty
  object that reads as "up to date".
- **Firmware — installing.** A local admin route that takes a `version` and does what
  `POST /device/<id>/firmware/install` does today, the doorbell downloading as it already does. Progress
  already exists locally (`GET /api/ota_from_url`). URI with the verb inside (handler table, R3).
- **VPS.** `firmware/latest` (and `list` if wanted) accept the doorbell's own auth, not only an app's.
- **Integration.** An `update` entity: `installed_version`, `latest_version`, `release_summary` (the notes,
  English per the changelog rule), `in_progress` + percentage, install → the local route.
- **Street panel.** A second `update` entity over `/api/panel_ota`, already local.

Side benefit: the apps can read the same field and stop asking the VPS themselves — one source of truth.

---

## 5. Effort and phases

**Assumptions:** one developer (agent + coordinator) who already knows HA integrations; weeks of 5 working
days; each phase includes testing on the Waveshare bench and then Ermita 10, a real HA, and the version bump
on every build (integration, card, firmware). Firmware routes include the contract update in the same
commit. Estimates are **[S]**.

| phase | content | effort |
|---|---|---|
| **0 — LAN-only and hygiene** | remove VPS paths #1–#9; setup fails clearly (§1.4); stop handing the credential to the browser; recordings through an HA view; English entity names + `translation_key` + translations; card cache-busting | **1 w** |
| **1 — What gets used at home** | snapshot `camera` (A); `binary_sensor` ringing/call; reboot `button`; SD, WiFi/IP, role, memory sensors; image (F1, F2, F4, F5), detection (F7), door (F9, F10), mic gain, device name, streams (G4, disabled); `car_open` switch; mode reason | **2 w** |
| **2 — Firmware for HA** | F-1: HTTP routes for `play_audio`, `play_sequence`, `rec_start`/`rec_stop` (one URI, verb inside); F-2: doorbell emits events 6/7/8 on the webhook; §4 update routes; then the integration's `update` ×2, quick-reply `select`+`button`, REC `switch`, actions | **2.5 w** (1.5 firmware + 1 integration) |
| **3 — Streaming camera** | after Dec-1: RTSP slot for HA, `camera` with `STREAM`, measurements (CPU, latency, fan-out), wall-panel passive mode in the card | **1.5 w** |
| **4 — Card completes the call** | decline, hang-up, quick replies during a call, REC button, audience; all consuming the entities from 1–2 | **1.5 w** |
| **5 — Read-only lists** | users, paired apps, keys, mode rules as sensors; `delete_recording` action; language/time zone `select` | **1 w** |
| | **total** | **≈ 9.5 weeks** |

**Why this order.** Phase 0 is a rule, not an improvement: today the integration and card can reach the
doorbell through the VPS. Phase 1 is almost all `get_states`/`save_states` fields the integration already
reads every 30 s — the largest jump in coverage for the least risk — plus the snapshot camera, which is the
most-used doorbell feature in any HA install (a picture in the ring notification). The streaming camera waits
for Dec-1 because it takes the only RTSP slot.

---

## 6. Risks and decisions

### Decisions for Iñaki

*(Already decided on 2026-09-25 and no longer open: the doorbell checks for firmware itself, §4.)*


- **Dec-1. The RTSP slot.** HA's streaming camera needs RTSP, which today accepts one connection reserved for a
  recorder. Options: (a) allow two connections (recommended), (b) HA takes the only one and no third-party
  recorder can coexist, (c) no streaming camera — snapshot only.
- **Dec-2. HTTP routes for call actions.** Quick replies, sequences and REC exist only as signalling messages.
  Add one local route for them (F-1), or leave them to the card and the apps.
- **Dec-3. The privacy sentence.** A `camera` entity lets the owner save clips and stills to their own HA.
  Accept it as the owner's choice (and say "we never store it" instead of "nowhere else"), or ship without
  `STREAM` and without `camera.record` support.
- **Dec-4. Opening the door without double confirmation.** The `button` entity opens on one press (§1.8 asks
  every client for two). Keep it as an automation primitive and document that dashboards should use the
  card, or turn it into a `lock` entity with HA's own confirmation.

### Risks

- **R1. Snapshot load.** Periodic stills from several dashboards could compete with a live call on a CPU
  that is already tight. Mitigation: shared cache, rate limit, no fetch during a call. Measure first.
- **R2. RTSP cost.** A second RTSP consumer is untested on the P4. Measure CPU and fps before promising B.
- **R3. Handler table.** Every new HTTP route costs a handler slot; the table has overflowed four times. One
  URI with the verb inside per group, and audit with the `DELETE` probe after flashing.
- **R4. Removing TURN from the card.** After Phase 0, the card's call works only where the browser reaches
  the doorbell's LAN address. That is rule 3 applied; it is written here so nobody reads it as a regression.
- **R5. Entities that act on the door or the network.** HA is a local client and may write what an app at
  home writes; the exclusions in §0 are the only guard. Any new writable entity must answer "is this a
  secret, irreversible, or an editor?" before it is added.
- **R6. Doorbells without a public certificate** cannot be added to HA (§1.4, point 4). Known and
  unchanged; setup must say it clearly instead of failing on TLS.

### Verified vs supposed, in one place

Verified: everything tagged [V-code] (read at the listed commits, not run) and [V-doc] (HA docs and PR, fetched
2026-09-25). Supposed, with what confirms each: snapshot refresh rate and cost (R1), go2rtc fan-out and
latency (3.2 B), second RTSP connection cost (R2), wall-panel switch (3.3), effort figures (§5), and that
Android matches iOS on `/api/img_settings`, `/api/storage_info`, reboot and OTA (Android's route list shows
`change_password`, `upload_cert`/`upload_key` and `whoami` that iOS lacks, and lacks those four literal
routes — they may be built differently; the union is what this plan inventories).

---

## 7. Phase 0 — done (2026-09-25): integration 0.7.1, card 1.9.1

Released and installed by HACS on the home Home Assistant (one HA restart, 13:25–13:28). Tags
`v0.7.1` (integration) and `v1.9.1` (card), both from `main`.

### VERIFIED (measured, with the instrument checked both ways)

- **No path to the VPS.** Test HA (container, HA 2026.9.3) started with **no DNS at all**
  (`--dns 127.0.0.1`), paired with the Waveshare and used for 4 min (setup, entities, live view,
  timeout, recordings, actions). Packet capture of the container: **0 DNS queries** and **0 packets to
  any non-private address**; 1,258 packets to the doorbell (80 and 8443). Positive controls on the
  same instrument: a manual `getaddrinfo` of a `*.doorbell.islautopia.com` name shows up; the old
  0.6.2 + card 1.8.1 in the same container made **12 DNS queries** (`<id>.doorbell…` ×8, `relay…` ×4)
  in one minute, and the old card's browser opened `wss://relay.doorbell.islautopia.com/...?token=<credential>`.
  New card in a real Chromium: **0 requests or websockets outside Home Assistant**. Home HA, Ermita 10,
  from the 41.x LAN (the tablet's): ICE pair **host → host, 2–3 ms**, same as before without TURN.
- **Setup without direct IP** fails with the "same network" message and creates nothing (unreachable
  IP: 6 s; a non-doorbell IP: at once).
- **The credential no longer reaches a browser**: `get_connection_info` returns only the device id and
  two entity ids; `get_turn_credentials` no longer exists; thumbnails and playback are signed HA URLs
  (range requests work, 206; without the signature, 401).
- **Live-view timeout, on the Waveshare's counters** (`/api/debug/video_drop` sig/view, `/cores`):
  timeout 30 s → `live_pause` at 31 s (`viewers_paused` 1), **slot freed at 46 s** (sig_used/view_used
  1 → 0); tap → new session; microphone open 54 s with a 30 s timeout → never paused; after hang-up a
  ring (webhook envelope) → new session. On the **living-room tablet** with Ermita (timeout 60 s):
  connected at 14 s, paused at 71 s, freed at 87 s, and **stayed at 0** for the next 93 s.
- **Leaving the view (Iñaki's rule of the same day)**: switching Lovelace view detaches the card on HA
  2026.9.3; now `live_pause` at once, back within 15 s = same session resumed; away longer = freed at
  +15 s; page close = freed at once.
- **Signalling for quick replies/sequences/REC**: an SSE that never answers the offer takes a
  **signalling** slot (`sig_used` 1/8) and **no viewer slot** (`view_used` 0/4); `play_audio` and
  `play_sequence` get their `*_result` on it. `rec_start` works too, but a manual recording **stops
  when that session ends** (`rec_state` false right after the `bye`), so REC needs a held session —
  not implemented. The actions `play_sequence`/`play_audio` are implemented and answer with the
  doorbell's own errors (`empty_slot`, `not_found`); the session always ends with `bye`.
- Tests: integration 20 pytest + 12/12 mutants killed; card simulation 53 checks, 2 negative and
  15 positive controls.

### Found on the way (firmware 0.100.0, not changed here)

- `POST /api/unpair_app` **by label** answers 404 when the label has a space, whatever the encoding
  (`+` or `%20`); by slot it works. The integration now undoes by slot. Every HA label has a space.
- `HEAD /api/recording` answers 405; the integration probes with a one-byte ranged GET.

### Bugs of 1.9.0 caught on the real tablet (fixed in 1.9.1)

- Re-insertion of the card by HA restarted a session after an idle pause → Ermita's slot flapped
  0→1→2→1 every ~20 s. The idle pause now lives per doorbell at module level; only a tap or a ring
  lifts it.
- The unload `bye` went by `sendBeacon` to a signed path; signed paths are GET-only, so it never
  arrived. Now a keepalive fetch with the Authorization header.

### BELIEVED, not measured

- The first poll right after the HA restart failed once for both doorbells (`Cannot connect … [None]`)
  and recovered 30 s later; believed to be the host network not being ready at boot. Confirm by
  watching the next restart.
- The Ermita card config still says `idle_release_seconds: 60`; since 1.9.0 the entity rules, so
  `number.calle_ig_doorbell_v5_tiempo_de_espera_de_la_vista_en_vivo` was set to **60** to keep
  Iñaki's choice. Nothing else of his configuration was touched.
- Pausing a live call when the view is left relies on `live_pause` releasing the talk floor and the
  card asking for it again on return; covered by the simulation, **not** tried with a real call
  (Ermita is off limits and the Waveshare had other viewers during the session).
