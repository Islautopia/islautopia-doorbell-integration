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
# ⚠️ 5 (Inaki, 2026-09-25: «hasta 5»), y no es un limite de memoria: esta lista es la LISTA BLANCA
# de lo que el portero puede mover en la casa -- la puerta y los pasos `hass` solo pueden apuntar
# a una de estas. Una lista blanca corta se revisa de un vistazo. Hasta la 0.7.5 eran 24. El
# portero rechaza con `400 too_many_entities` en vez de recortar.
MAX_ENTIDADES = 5
CONF_ENTIDADES = "entidades"

# --- El modo del portero (§1.2, campo `m`) ----------------------------------------------------
# ⚠️ El 2 se llamaba "Noche" y el contrato lo nombraba de las dos formas, lo que llevaba a que cada
# cliente eligiera una. Unificado a **"No molestar"**, que describe lo que hace en vez de cuándo se
# supone que se usa. El valor numérico NO cambia: sigue siendo 2, así que no hay nada que migrar.
#
# ⚠️ Los valores son CLAVES de traduccion (2026-09-25), no textos: Home Assistant traduce el estado de
# un `select` con `translation_key`, asi que lo que lee el dueno sale en su idioma y lo que guarda
# una automatizacion es estable. Hasta la 0.6.x el estado era el texto en espanol ("Ausente").
MODOS: dict[int, str] = {
    0: "normal",
    1: "away",
    2: "do_not_disturb",
    3: "custom",
}

# El tiempo de espera de la vista en vivo (entidad `number`, lo aplica la card). Ver number.py.
LIVE_TIMEOUT_DEFAULT_S = 120
LIVE_TIMEOUT_MAX_S = 3600

# --- Config entry data keys -----------------------------------------------------------------
CONF_DEVICE_ID = "device_id"
CONF_CREDENTIAL = "credential"
CONF_HOST_HINT = "host_hint"
CONF_LABEL = "label"

# Confirmed against the firmware: use this fixed label so every
# HA instance that pairs with a given doorbell is identifiable in the cloud admin panel.
DEFAULT_PAIR_LABEL = "Home Assistant"


def nombre_generico(device_id: str) -> str:
    """El nombre a mostrar cuando el portero no tiene `dname` configurado (§0-bis).

    ⚠️ NUNCA el id a secas (Inaki, 2026-09-26): «el nombre del portero si es util, el id
    despista mucho» -- buscando donde configurar sus entidades no reconocio la entrada porque
    se llamaba igual que su device_id. Mismo formato que sintetiza el propio firmware para su
    instancia mDNS cuando nadie ha bautizado el portero (API_CONTRACT.md, mDNS/Zeroconf,
    "IG Doorbell <device_id>"), para que el generico sea el mismo en todos los clientes.
    """
    return f"IG Doorbell {device_id}"

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
REQUEST_TIMEOUT = 8  # seconds - one-shot REST calls to the doorbell, not streams

# --- The doorbell's certificate name (API_CONTRACT.md §0) -------------------------------------
# ⚠️ ONLY the name the doorbell's TLS certificate is issued for. It is used for SNI and certificate
# validation and is NEVER resolved: the socket always goes to the LAN address this integration
# stored (net.py). There is deliberately no relay host here any more (2026-09-25, Phase 0): Home
# Assistant is a LOCAL client and never reaches the doorbell through the VPS, not even as a fallback.
DOORBELL_HOSTNAME_SUFFIX = "doorbell.islautopia.com"

# --- What the doorbell may act on, and how (contract 4) -------------------------------------
# ⚠️ ONLY THINGS THAT TURN ON AND OFF (Inaki, 2026-09-25). The same list lives in the firmware
# (`hass_domain_allowed`, main/hass.c) and each side checks its own half: the doorbell refuses to
# store anything else, and this integration refuses to act on anything else.
#
# Left out on purpose, and it is not an oversight:
# - `button`, `scene`, `script` (accepted up to 0.7.5): they have no opposite state, so the door's
#   automatic close after `dur` seconds and a sequence step with `on: false` would mean nothing -
#   a setting that silently does nothing is the failure this project keeps hunting.
# - `cover`: a blind has positions in between and "open" takes a while; it is not a switch.
#
# In a LOCK, "on" means OPEN (`lock.unlock`) and "off" means CLOSE (`lock.lock`). Everything else
# maps to `turn_on` / `turn_off` of its own domain.
DOMINIOS_PERMITIDOS: tuple[str, ...] = ("fan", "input_boolean", "light", "lock", "siren", "switch")

DOMAIN_OPEN_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "unlock"),
    "light": ("light", "turn_on"),
    "switch": ("switch", "turn_on"),
    "input_boolean": ("input_boolean", "turn_on"),
    "fan": ("fan", "turn_on"),
    "siren": ("siren", "turn_on"),
}
DOMAIN_CLOSE_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "lock"),
    "light": ("light", "turn_off"),
    "switch": ("switch", "turn_off"),
    "input_boolean": ("input_boolean", "turn_off"),
    "fan": ("fan", "turn_off"),
    "siren": ("siren", "turn_off"),
}
