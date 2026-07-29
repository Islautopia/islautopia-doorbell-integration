# Changelog

All notable changes to this integration are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [0.4.1] — 2026-07-29

### Fixed

- **Looking up a paired doorbell relied on luck.** The lookup walked everything the integration
  keeps in memory and accepted anything shaped like a config entry. The state of the shared MQTT
  listener is stored in the same place and is shaped the same way, so it was examined too — it
  only ever stayed out of the way because it happens to carry no device id. Anything added there
  later with one would have been matched silently. The lookup now asks Home Assistant which config
  entries exist and checks those, and nothing else.

  No behaviour changes today. This is a trap removed before it could be sprung.

---

## [0.4.0] — 2026-07-29

**First public release.** Until now this integration was only available privately, which meant it
could not be installed or updated through HACS the way any other integration can. That is fixed:
the repository is public, and updates arrive normally from here on.

If you are coming from an older copy installed by hand, this is also the version that carries the
"door opens but never closes" fix from 0.3.0 — see below.

### Changed

- Everything a developer or an administrator reads is now in English: code comments and every log
  message. The interface you actually see in Home Assistant stays translated, Spanish included.
- Diagnostic messages that used to be logged at `info` on every start and reload are now at
  `debug`. They were left over from tracking down a bug and had no business in everyone's log.
- Documentation rewritten around what the integration does for you and how to set it up, instead
  of how it was built.

---

## [0.3.0] — 2026-07-11

### Fixed

- **The door opened and never closed.** When the doorbell is set to control a Home Assistant
  entity, it sends an `open` and then, once the configured open duration has passed, a `close`.
  This integration discarded anything that was not literally `open`, so the light, switch or lock
  you had chosen turned on and stayed on forever — no error, no warning, nothing in the log above
  debug level.

  Reported by a real user as *"the light comes on but never goes off by itself"*.

  Closing now works for `lock`, `cover`, `light`, `switch` and `input_boolean`. It is deliberately
  **not** implemented for `button`, `scene` and `script`: none of them has a meaningful opposite —
  a button is not "un-pressed", and a scene or a script is a one-shot action with no state to
  return to. Inventing a fallback for those would be worse than doing nothing, so a `close` for
  them is a quiet no-op rather than a warning about a gap that is not a gap.

---

## [0.2.0] — 2026-07-10

### Fixed

- **The doorbell appeared twice in Home Assistant, and one of the two looked broken.** The
  integration registered its device under its own identifier only, while the doorbell's own MQTT
  discovery registered the same physical device under a different one. Home Assistant treated them
  as two: ours, empty and apparently faulty, and a separate one holding all the real entities.

  Found on real hardware, and the failure was silent — no error appeared anywhere, the device just
  said it had no entities. The integration now registers both identifiers so Home Assistant merges
  them into a single device.

- **The device kept losing the name you gave it.** The integration set the device name on every
  start and reload, overwriting whatever name was already stored — including the one the doorbell
  itself had published. The result was a device that sometimes showed a generic name instead of
  yours, depending on which component wrote last. The integration no longer touches the name.

### Removed

- **Server-side mDNS resolution of the doorbell's local address.** It resolved an address that
  nothing actually used, and it cost up to four seconds on every session start. It was also the
  wrong approach: mDNS is link-local traffic and does not cross network segments, so on any
  network with VLANs it would have failed anyway.

  Discovery during pairing is unaffected — that one is optional, and typing the address by hand has
  always been available alongside it.

---

## [0.1.0] — 2026-07-09

First release.

- Pairing through Home Assistant's own setup flow, with discovery on the local network and manual
  address entry as an alternative. The administrator password is used once and never stored.
- Automatic dispatch of the doorbell's door action to the right Home Assistant service, worked out
  from the kind of entity you point it at.
- A bridge that lets the companion Lovelace card reach the doorbell without anything to configure
  by hand.

[0.4.1]: https://github.com/Islautopia/islautopia-doorbell-integration/releases/tag/v0.4.1
[0.4.0]: https://github.com/Islautopia/islautopia-doorbell-integration/releases/tag/v0.4.0
[0.3.0]: https://github.com/Islautopia/islautopia-doorbell-integration/releases/tag/v0.3.0
[0.2.0]: https://github.com/Islautopia/islautopia-doorbell-integration/releases/tag/v0.2.0
[0.1.0]: https://github.com/Islautopia/islautopia-doorbell-integration/releases/tag/v0.1.0
