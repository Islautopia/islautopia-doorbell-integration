# IG Doorbell for Home Assistant

The Home Assistant integration **and** dashboard card for the **Islautopia Garage Doorbell**
(IG Doorbell) — a video doorbell that keeps your video and audio on your own hardware.

One install from HACS gives you both: the doorbell as a real Home Assistant device, and a live
view card with two-way audio and door control. The card needs no resource, no YAML and no options.

---

## Two principles this is built on

**Local first.** Everything here works inside your home network with no internet at all. Home
Assistant talks to the doorbell at its local address — no cloud relay, no TURN, not even a DNS
lookup of the doorbell's cloud name. If your line or our servers go down, the live view, two-way
audio, the door, the recordings and your automations keep working.

**Privacy first.** Not a frame of video or a second of audio is stored anywhere but on the
doorbell's own memory card. The live stream goes straight from the doorbell to your browser. The
pairing credential stays on your Home Assistant server and never reaches a browser.

---

## Installing

### With HACS (recommended)

1. In HACS, open the **⋮** menu and choose **Custom repositories**.
2. Paste `https://github.com/Islautopia/ig-doorbell-hass` and pick the **Integration** category.
3. Find **Islautopia Garage Doorbell** in the list and download it.
4. Restart Home Assistant.

That is the whole install: the card comes with the integration. You do **not** add a dashboard
resource, and there is no separate card repository to install.

### By hand

Copy the `custom_components/ig_doorbell/` folder (it includes `frontend/`) into your Home Assistant
`custom_components` folder, then restart.

### Before you start

1. **An IG Doorbell that is already set up** — on your network, with an administrator account.
   If it is brand new, set it up from the mobile app or its own web page first.
2. **Home Assistant 2024.7 or newer.**
3. **Home Assistant reachable from the doorbell on your own network.** The doorbell writes to it
   directly, so Home Assistant needs a *local* address (Settings → System → Network → *Home
   Assistant URL*). Sending the doorbell out to the internet to reach a machine next door would
   mean this stops working the day your line goes down.

---

## Setting it up

**Settings → Devices & services → Add integration → Islautopia Garage Doorbell.** If the doorbell
is on the same network, Home Assistant may already offer it under *Discovered*. Otherwise type its
address — the reliable route when the doorbell and Home Assistant sit on different VLANs, where
discovery cannot reach.

Then enter the doorbell's administrator email and password. They are used **once**, to ask the
doorbell for a dedicated pairing credential, and are never stored. Repeat for each doorbell you
have.

Then add the card to a dashboard: **Edit dashboard → Add card → IG Doorbell**. Or in YAML:

```yaml
type: custom:ig-doorbell-card
```

That is the whole card configuration.

---

## The card

- **Every doorbell, one card.** A switcher in the header lists every doorbell of the integration
  by its own name and switches live. Switching hangs up the old session completely and builds a
  fresh view for the new doorbell — nothing of one doorbell leaks into the other.
- **Live video in about a second**, two-way audio without renegotiating, and a single talk turn
  shared with the mobile apps (if someone else is talking, you are told, not cut in).
- **Door with confirmation**: the first press arms, the second opens, and the card only says
  *Open* once the doorbell confirms it. No door button when the doorbell has no lock.
- **Watching is not listening**: the speaker starts muted, and turns on when you tap it or when
  someone rings.
- **Mode**, **REC** (administrators), **Recordings** (Home Assistant's own media browser, played
  through Home Assistant so the credential stays on the server), **Quick replies** played at the
  street, and a **bell** with the doorbell's recent notices.
- **Adaptive layout**: stacked, overlaid or side column, chosen from the space the dashboard
  gives it; 44 px touch targets on touch screens; fullscreen that works in the companion app too;
  pinch to zoom.
- **Leaves the doorbell alone when nobody is looking**: leaving the view pauses the stream at once
  and frees the doorbell after a grace period (unless you are in a call); the *Live view timeout*
  entity pauses it when nobody touches the card.
- Translated to English, Spanish, Portuguese, German, French, Russian, Chinese, Hindi and Arabic.

### Updating

HACS updates the integration and the card together. After the update, **restart Home Assistant**
(HACS asks for it) and **reload the browser page**. The card's address carries a fingerprint of the
file, so browsers fetch the new card instead of reusing a cached one — no cache clearing needed.

---

## The integration

### Entities, with nothing to configure

| | |
|---|---|
| **Events** | everything the doorbell has to say — a ring, a visitor, a parcel, the door opened, a key refused. Use it directly as an automation trigger |
| **Visitor** / **Parcel in the doorway** | the ones you want as a state rather than an instant |
| **Mode** | Normal, Away, Do Not Disturb, Custom — *"Do Not Disturb at 23:00"* is a two-line automation |
| **Open door** | a button, when your doorbell has a lock configured |
| **Manual recording** | a switch (administrators) |
| **Viewers** | how many people are watching right now |
| **Live view timeout** | seconds without anyone touching the card before it pauses the live view (default 120, `0` = never) |
| Firmware, street panel, fingerprint reader | diagnostics |

Changing the mode or recording needs the pairing to be an **administrator** of that doorbell; the
card shows REC and Recordings by the same rule, whatever Home Assistant account is looking.

### The doorbell's open button can drive your Home Assistant devices

On the doorbell, set the door type to **Home Assistant** and pick the entity to control. Which
entities the doorbell may touch is a short allow-list you choose in **Settings → Devices &
services → Islautopia Garage Doorbell → Configure** (up to 5):

| You point the doorbell at… | Open does | Then, on its own |
|---|---|---|
| `lock.front_door` | `lock.unlock` | `lock.lock` |
| `cover.garage` | `cover.open_cover` | `cover.close_cover` |
| `light.porch` / `switch.gate` / `input_boolean.…` | `turn_on` | `turn_off` |
| `button.…` | `button.press` | — |
| `script.…` / `scene.…` | runs it | — |

The close is sent after the open duration you set on the doorbell, so a lock re-locks and a light
turns itself off.

### Actions

`ig_doorbell.play_sequence` and `ig_doorbell.play_audio` play one of the doorbell's sequences or
quick replies at the street — the same messages the apps send.

### What it does *not* do

- **It never reaches the doorbell through the internet**, and the live view therefore works
  wherever the browser can reach the doorbell on your network, not from outside. Home Assistant
  must be on the same network as the doorbell (or a routed VLAN); if it cannot reach it, setup
  says so and configures nothing.
- **Your live video and audio never pass through Home Assistant.** Recordings you open do, so the
  credential stays on the server.
- **No MQTT broker, no session kept open.** The doorbell pushes what is urgent over a local
  webhook the moment it happens; the integration asks how things are every 30 seconds.

---

## If something does not work

**The card says "Custom element doesn't exist: ig-doorbell-card".** Home Assistant was not
restarted after installing, or the page was not reloaded after the restart.

**Nothing happens when the door is opened.** Check that the doorbell's door type is *Home
Assistant* and that the entity is in the allow-list under *Configure*.

**The entities are all unavailable.** The integration cannot reach the doorbell. If it says the
doorbell no longer recognises it, the pairing is gone — re-pair from *Configure*.

**Nothing arrives the moment it happens, but the entities are fine.** The doorbell does not know
where to write: Home Assistant has no local address configured (see *Before you start*), or the
pairing is not an administrator of that doorbell. The log says which.

More detail in the log:

```yaml
logger:
  logs:
    custom_components.ig_doorbell: debug
```

---

## For developers

- Integration tests: `python -m pytest tests -q` in a container with
  `pytest-homeassistant-custom-component`; `python tools/mutants.py` re-breaks each rule and checks
  the suite goes red.
- Card benches: `cd tests/card && npm install && node run_all.js` (Playwright + simulations, with
  their own positive and negative controls). What the card has learned so far is in
  [docs/card.md](docs/card.md).

## License

MIT — see [LICENSE](LICENSE). Made by [Islautopia Garage](https://islautopia.com).
