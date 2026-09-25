# Changelog

All notable changes to this integration are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [0.7.2] — 2026-09-25

### Added

- **A manual-recording (REC) switch.** Pressing it starts a recording on the doorbell exactly like
  the apps' REC button (`rec_start`, API_CONTRACT.md §1.4-quater); turning it off, or the doorbell
  itself ending the recording (the 10-minute cap, another admin, a ring taking the slot for a
  call), stops it (`rec_stop`).

### Fixed

- **A manual recording started from Home Assistant stopped after a fraction of a second.** REC
  rides the same signalling session as a quick reply, and that session used to close itself
  (`bye`) right after the doorbell's first reply — and API_CONTRACT.md §1.4-quater rule 4 says a
  manual recording stops the moment the session that started it ends. The switch now keeps that
  session open for as long as the recording lasts, and its state is always the doorbell's own
  `rec_state`, not "a session happens to be held" — a refusal (not an administrator, no usable SD
  card, already recording something else) is reported as an error, not a silent no-op. Measured on
  the Waveshare: a 1-2 minute REC from Home Assistant runs to completion, and the signalling slot
  (`sig_used`) returns to 0 when it ends.

## [0.7.1] — 2026-09-25

### Fixed

- **Undoing a failed pairing left it alive on the doorbell.** The undo asked the doorbell to remove
  the pairing by its name, and the doorbell (firmware 0.100.0) answers "not found" to any name with
  a space in it — every Home Assistant pairing name has one. It now looks the pairing up and removes
  it by its slot. Measured on the doorbell: the pairing is gone afterwards.

## [0.7.0] — 2026-09-25

### Changed — Home Assistant is a local client

- **The integration never talks to the doorbell through the internet any more.** No cloud relay,
  no TURN credentials, and no DNS lookup of the doorbell's cloud name: requests go to the doorbell's
  address on your network, and the certificate is still validated against the doorbell's name.
  **Home Assistant must be on the same network as the doorbell (or a routed VLAN).**
- **Setup checks it and says so.** The doorbell must answer at its IP on port 80 and on its secure
  port with a valid certificate; otherwise setup stops with one clear message and configures
  nothing. If a pairing succeeds but its credential then fails, it is undone on the doorbell.
- **New option "Doorbell address"** to change the IP when the doorbell moves (zeroconf still updates
  it automatically when it can see the doorbell).
- **New entries use a pairing name of their own** ("Home Assistant <your location name>"), so a
  second Home Assistant paired by the same administrator no longer takes over the first one's
  access. Existing entries keep theirs.

### Fixed — the pairing credential reached every user's browser

- `get_connection_info` no longer returns the credential, and recordings in the media browser are
  served through Home Assistant (signed URLs, range requests for seeking) instead of a direct URL
  to the doorbell carrying `?token=<credential>`.
- Playing a recording failed on current firmware: the doorbell answers `HEAD` with 405. The probe
  is now a one-byte ranged request.
- The media browser shows the doorbell's name instead of the pairing name.

### Added

- **Live view timeout** (`number`, seconds, default 120, `0` = never): after that long without
  anyone touching it, the Lovelace card pauses the live view and frees the doorbell's slot, like the
  apps do in the background. Never during a call; a tap or a new ring resumes. An automation can
  change it.
- Actions **`islautopia_doorbell.play_sequence`** and **`islautopia_doorbell.play_audio`**: play a
  sequence or a quick reply at the street, over the same signalling messages the apps use.
- Entity names in English with translations (English, Spanish, Portuguese, German, French,
  Russian, Chinese, Hindi, Arabic). Existing entity ids do not change. **The mode `select` now
  reports stable states** (`normal`, `away`, `do_not_disturb`, `custom`) shown translated;
  automations that compared it with the old Spanish labels must use the new values.

## [0.6.2] — 2026-09-16

### Fixed

- **The front door stopped opening after Home Assistant restarted during an internet outage.**
  At setup the integration tells the doorbell where to send its webhooks. It worked out its own
  address by asking which IP it uses to reach the internet. On 2026-09-15 Home Assistant restarted
  while the line was down, so that answer was the Supervisor's internal Docker bridge
  (`172.30.32.1`). That address was sent to the doorbell, which can never reach it, and the door
  button silently stopped working until someone noticed the next day.

  The address is now taken from the route **to the doorbell itself**, which exists on the local
  network even without internet. Addresses from Home Assistant's internal container networks are
  never sent, and a warning is logged if they come up.

## [0.6.1] — 2026-08-24

### Fixed

- **A stored doorbell address is no longer trusted blindly.** When the doorbell moved to its final
  VLAN, the address saved at pairing stopped being its, and every call silently fell back to public
  DNS. At setup the stored address is now checked with `GET /api/device_id` (no side effects), the
  `device_id` is compared, and if it no longer matches, the current address is learned and saved.

## [0.6.0] — 2026-08-24

### Changed

- **The doorbell is reached on the local network first**, so an internet outage no longer takes the
  door button and the card down. Calls keep using the doorbell's public hostname (so certificate
  validation is unchanged), but it is resolved to the LAN address first and to public DNS only after.

## [0.5.1] — 2026-08-24

### Corregido

- **Borrar el dispositivo de MQTT se llevaba esta integracion por delante.** Medido en una
  instalacion real el mismo dia: Inaki borro el dispositivo que habia creado el autodescubrimiento
  de MQTT y **la puerta dejo de abrirse**.

  Nuestro dispositivo llevaba dos identificadores a proposito -- el nuestro y el de MQTT-- para que
  Home Assistant fusionara los dos en uno solo. Eso era correcto mientras existian ambos, y tenia
  un coste que estaba escrito aqui como «no cuesta nada»: al compartir dispositivo, **borrar el de
  MQTT borra tambien nuestra entrada de configuracion**, y con ella el webhook. El videoportero
  siguio escribiendo a una direccion que ya no escuchaba nadie, sin que nada lo explicara.

  Y una segunda mitad que ese dia solo se libro por suerte: al borrarse una entrada, la integracion
  **le dice al videoportero que deje de escribir**. Fallo porque la credencial de esa entrada ya
  estaba muerta. Con una viva habria funcionado, y el videoportero se habria callado por un borrado
  que el usuario no dirigio contra nosotros.

  La fusion ya no compraba nada: el firmware dejo de hablar MQTT esa misma manana.

## [0.5.0] — 2026-08-24

Esta version cambia como habla el videoportero con Home Assistant, y con ello quien crea las
entidades. Si vienes de una anterior, lee lo primero.

### Cambiado

- **Se acabo MQTT. El videoportero escribe ahora directamente a Home Assistant, por un webhook.**

  Un broker era un requisito previo que la mitad de la gente que instala esto no cumple, y esta
  integracion tiene que funcionar en un Home Assistant instalado esta manana, igual que funcionan
  las apps. **Ya no hace falta ningun broker, ni la integracion MQTT.**

  El videoportero manda **el mismo sobre** que ya componia para el relay. Un formato propio para
  Home Assistant habria sido un quinto dialecto que mantener.

- **Las entidades las crea ahora esta integracion**, no el autodescubrimiento del videoportero.

  Lo que lo desbloqueo es mas pequeno de lo que parece: leer el estado del videoportero exigia la
  contrasena de administrador, que es justo lo que el emparejamiento existe para evitar, asi que
  esta integracion no podia construir ni una sola entidad. El firmware lo corrigio el mismo dia.

### Anadido

- **Una entidad de eventos** con todo lo que el videoportero cuenta: alguien llamo, un visitante,
  un paquete, la puerta se abrio, una llave rechazada. Una sola entidad y la lista de tipos
  abierta, a proposito: asi una funcion nueva del videoportero se puede automatizar el mismo dia,
  sin esperar a que esta integracion se actualice.
- **Visitante** y **Paquete en la puerta**, para lo que se prefiere como estado y no como instante.
- **Modo** (Normal, Ausente, No molestar, Custom). Cambiarlo exige que el emparejamiento sea
  administrador de ese videoportero; leerlo, no.
- **Abrir puerta**, y **solo si ese videoportero tiene cerradura configurada**. No se dibuja
  apagado: no se dibuja.
- **Espectadores**, y diagnosticos de firmware, panel de calle y lector de huellas.
- **Un selector de entidades** en las opciones: eliges cuales puede accionar el videoportero, y
  solo esas se ofrecen en las apps. Hasta 24 -- no es un limite de memoria, es cuantas caben en un
  desplegable antes de dejar de ser una lista.

### Corregido

- **Volver a emparejar borraba la configuracion de las opciones.** Un flujo de opciones reemplaza
  el diccionario entero, y el paso de reemparejar devolvia uno vacio. Nunca se noto porque hasta
  hoy no habia ninguna opcion que perder.

### Corregido, el mismo dia

- **La direccion que se le daba al videoportero podia ser publica.**
  `get_url(allow_external=False)` solo dice *no uses la externa*: si el `internal_url` configurado
  es a su vez un nombre publico, lo devuelve tal cual. **En una instalacion real de las nuestras es exactamente el caso** -- las dos
  URL valen el mismo hostname publico-- asi que el videoportero habria salido a internet, DNS al
  menos, para hablar con una maquina que tiene en la LAN de al lado. Sin ningun error: solo dejaria
  de funcionar el dia que se caiga la linea.

  Ahora se prefiere **la IP** con la que Home Assistant sale a su propia red, que es lo unico que no
  necesita que nada resuelva un nombre. Si aun asi acaba siendo un nombre, **se dice en el registro**
  en vez de aceptarlo callando.

### Si vienes de 0.4.x

El videoportero deja de publicar por MQTT, asi que **las entidades viejas se quedaran como no
disponibles**. Se pueden borrar. Las nuevas aparecen solas en el mismo dispositivo.

Y hay que darle a Home Assistant **una direccion local** en Ajustes -> Sistema -> Red, si no la
tiene: es a donde el videoportero escribe. Tiene que ser la de tu red -- mandarlo a internet para
alcanzar una maquina que tiene al lado significa que esto deja de funcionar el dia que se caiga la
linea.

---

## [0.4.3] — 2026-07-29

### Corregido

- **El relevo de senalizacion llevaba cinco dias sin llegar a nadie.** Aparecio en 0.4.2 pero es
  posterior a esa etiqueta, asi que ninguna instalacion lo tenia: la integracion contestaba
  `unknown_command` a la card, que es exactamente lo que hace una version anterior.

  Importa mas que una publicacion olvidada normal. Un reinicio a fabrica borra los emparejamientos
  del aparato mientras la nube conserva el suyo, asi que el camino local empieza a devolver `401`
  y el remoto sigue funcionando. Sin el relevo la card **no puede verlo** -- `EventSource` no
  expone el codigo de estado-- y caeria al relay en silencio, mas lenta y sin nada que lo
  explicara. El relevo deja pasar ese `401`, que es para lo que existe.

---

## [0.4.2] — 2026-07-29

*(Entrada reconstruida el 2026-08-24 a partir de los commits: esta version se publico sin pasar
por este fichero.)*

### Anadido

- **Home Assistant hace de relevo de la senalizacion del videoportero**, para que el camino local
  sobreviva en iOS.
- **Un origen de medios** con las grabaciones del videoportero.

### Cambiado

- El icono viaja dentro de la integracion, que es como se hace ahora.

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
