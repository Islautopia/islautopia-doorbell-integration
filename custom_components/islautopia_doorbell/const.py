"""Constants for the Islautopia Doorbell integration.

See ARCHITECTURE.md (repo root) for the design this implements, and
API_CONTRACT.md in the IG_Doorbell firmware repo for the interface these values come from.
"""
from __future__ import annotations

DOMAIN = "islautopia_doorbell"

# --- Webhook (API_CONTRACT.md §4) -----------------------------------------------------------
# ⚠️ LA MARCA QUE DEVUELVE NUESTRO HANDLER, y no es decorativa: Home Assistant contesta `200` a un
# webhook que NO existe (medido el 2026-08-24 contra un HA real, con el cuerpo vacío), a propósito,
# para que nadie pueda enumerar los webhook de una instalación probándolos. Así que por código de
# estado el portero no puede distinguir «entregado» de «HA se olvidó de mí», y uno cuya integración
# se borró dispararía al vacío para siempre con su contador de fallos en cero. La marca es lo único
# que rompe ese empate. Ver webhook.py.
WEBHOOK_MARCA = "igd"

# Señal interna: un sobre del portero, del webhook a las entidades. Una por portero.
SIGNAL_EVENTO = "islautopia_doorbell_evento_{device_id}"

# Cada cuánto se le pregunta al portero por su estado. Sustituye al LWT de MQTT: si `get_states`
# falla, las entidades pasan a no disponibles, y eso sale gratis en vez de necesitar un mensaje
# póstumo que alguien tenga que configurar.
#
# 30 s y no 5: casi todo lo que cambia deprisa llega **empujado** por el webhook, así que el sondeo
# solo cubre lo que cambia sin avisar (el modo desde el dashboard, el número de espectadores, que
# aparezca un panel de calle). Sondear más a menudo castigaría al portero -- `esp_http_server`
# atiende de una en una-- para refrescar cosas que casi nunca se mueven.
INTERVALO_SONDEO = 30

# --- Entidades de Home Assistant que el portero puede accionar (§4) ---------------------------
# ⚠️ 24 NO es un límite de memoria: caben cientos en el almacén del portero. Es **cuántas caben en
# un desplegable sin que aquello sea un catálogo**, el mismo criterio que las 20 respuestas rápidas
# de §1.18.2. El portero rechaza con `400 too_many_entities` en vez de recortar.
MAX_ENTIDADES = 24
CONF_ENTIDADES = "entidades"

# --- El modo del portero (§1.2, campo `m`) ----------------------------------------------------
# ⚠️ El 2 se llamaba "Noche" y el contrato lo nombraba de las dos formas, lo que llevaba a que cada
# cliente eligiera una. Unificado a **"No molestar"**, que describe lo que hace en vez de cuándo se
# supone que se usa. El valor numérico NO cambia: sigue siendo 2, así que no hay nada que migrar.
MODOS: dict[int, str] = {
    0: "Normal",
    1: "Ausente",
    2: "No molestar",
    3: "Custom",
}

# --- Config entry data keys -----------------------------------------------------------------
CONF_DEVICE_ID = "device_id"
CONF_CREDENTIAL = "credential"
CONF_HOST_HINT = "host_hint"
CONF_LABEL = "label"

# Confirmed against the firmware: use this fixed label so every
# HA instance that pairs with a given doorbell is identifiable in the cloud admin panel.
DEFAULT_PAIR_LABEL = "Home Assistant"

# --- Zeroconf (API_CONTRACT.md §0-bis) ------------------------------------------------------
# Only used for the OPTIONAL pairing-discovery step in config_flow.py (async_step_zeroconf) -
# HA Core matches this against manifest.json's own "zeroconf": ["_igdoorbell._tcp.local."]
# declaration (the actual source of truth for that, not a Python constant) and routes matching
# announcements there. Match discovered instances by the `device_id` TXT record, NEVER by the
# mDNS instance name - the instance name tracks the doorbell's user-editable `device_name` and
# can change at any time (confirmed against the firmware).
#
# Deliberately NOT relied on anywhere else (2026-07-10): a previous
# `discovery.py` module used mDNS to resolve a doorbell's current LAN IP on every card session
# start - removed entirely. Two independent reasons: the card never actually used that value to
# connect (always uses the public hostname, see ARCHITECTURE.md §5/§7 "Q7"), and mDNS is
# multicast, which normally does not cross VLAN/subnet boundaries - relying on it would be
# actively wrong (not just unused) for any doorbell provisioned manually by IP because it lives
# on a different VLAN/subnet than the HA host, a real, legitimate setup. Pairing discovery here
# stays fine because it's purely optional/opportunistic - manual IP entry in config_flow.py
# always works as the real fallback, regardless of network segmentation.
#
# --- HTTP -------------------------------------------------------------------------------------
REQUEST_TIMEOUT = 8  # seconds - these are one-shot REST calls (pairing, TURN creds), not streams

# --- Relay / cloud (API_CONTRACT.md §3) -------------------------------------------------------
RELAY_HOST = "relay.doorbell.islautopia.com"
DOORBELL_HOSTNAME_SUFFIX = "doorbell.islautopia.com"

# --- `hass_action` dispatch table (§4) --------------------------------------------------------
# Era la tabla de `videoportero/door/action` por MQTT y no ha cambiado de forma: lo que cambia es el
# transporte. Y no es solo la puerta -- un paso de secuencia puede accionar cualquier entidad.
# entity_id domain -> (service domain, service name). Extend this table, don't special-case
# individual entities - see webhook.py.
DOMAIN_OPEN_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "unlock"),
    "cover": ("cover", "open_cover"),
    "light": ("light", "turn_on"),
    "switch": ("switch", "turn_on"),
    "button": ("button", "press"),
    "input_boolean": ("input_boolean", "turn_on"),
    "script": ("script", "turn_on"),
    "scene": ("scene", "turn_on"),
}
# Best-effort for any domain not in the table above - logged loudly so the gap is visible
# instead of a silent no-op. See webhook.py.
FALLBACK_SERVICE: tuple[str, str] = ("homeassistant", "turn_on")

# Symmetric "close" table, added 2026-07-11 after a real bug: the firmware
# (main/hardtask.c::open_door(), fixed the same day) now publishes a "close" action
# ({"action":"close","entity_id":"<same ha_e>"}) (hoy `hass_action` por el webhook, contrato §4) automatically
# `open_duration_s` seconds after "open", in door_m=1 (Home Assistant) mode - symmetric with what
# the physical relay (door_m=0) has always done. Before this table existed, webhook.py
# discarded any action != "open" outright, so the light/switch/lock/cover the user configured as
# `ha_e` would open and then just... stay open forever, no error, no warning: a real production
# bug ("the light turns on but never turns itself off"), not a missing feature request.
#
# Deliberately NOT a mirror of DOMAIN_OPEN_SERVICE with every domain filled in: "button" and
# "scene" (and, by the same reasoning, "script") don't have a natural "close" - a button doesn't
# "unpress", a scene/script is a one-shot action with no defined opposite state to return to.
# Forcing them into this table with a made-up fallback would be worse than doing nothing - see
# webhook.py, where a "close" for a domain missing here is a silent DEBUG no-op, not the
# loud WARNING that a missing "open" mapping gets (an "open" gap is a real hole to fill; a
# "close" gap for one of these three is a legitimate property of the domain, not a hole).
DOMAIN_CLOSE_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "lock"),
    "cover": ("cover", "close_cover"),
    "light": ("light", "turn_off"),
    "switch": ("switch", "turn_off"),
    "input_boolean": ("input_boolean", "turn_off"),
}
