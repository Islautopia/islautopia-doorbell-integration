"""Dispatch `videoportero/door/action` MQTT messages to the right Home Assistant service.

This module is the actual point of the whole integration. The doorbell firmware publishes this
topic whenever `door_mode=1` ("modo Home Assistant") and someone opens the door (see
API_CONTRACT.md §4 and `main/hardtask.c::open_door()` in the IG_Doorbell firmware repo):

    {"action": "open", "entity_id": "<value of ha_e configured on the doorbell>"}

And, since 2026-07-11 (COORDINATION.md Q25), automatically `open_duration_s` seconds later, a
symmetric close - same shape, same entity_id, no separate config on our side needed:

    {"action": "close", "entity_id": "<same value of ha_e>"}

MQTT is pure pub/sub - without something subscribed and dispatching, the message reaches the
broker and nothing happens. Before this integration, the only way to make it do anything was a
hand-written HA Automation - unacceptable friction for a commercial product. This listener
removes that step entirely: zero HA-side configuration beyond installing the integration and
pairing a doorbell.

The topic is intentionally NOT scoped per device_id (see COORDINATION.md Q3, a firmware
limitation, not ours to fix) - it doesn't need to be, because the entity_id to act on already
travels inside the JSON payload. That means this listener is started once, globally, the first
time any islautopia_doorbell config entry loads, and stays alive for as long as at least one
entry is loaded (reference-counted) - it never needs to know how many doorbells are configured
or which one sent a given message.
"""
from __future__ import annotations

import json
import logging

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceNotFound

from .const import (
    DOMAIN,
    DOMAIN_CLOSE_SERVICE,
    DOMAIN_OPEN_SERVICE,
    FALLBACK_SERVICE,
    MQTT_DOOR_ACTION_TOPIC,
)

_LOGGER = logging.getLogger(__name__)

_LISTENER_KEY = "door_action_listener"


async def async_ensure_door_action_listener(hass: HomeAssistant) -> None:
    """Make sure exactly one subscription to videoportero/door/action is active.

    Call once from async_setup_entry for every config entry that loads - reference-counted so
    the subscription survives as long as at least one entry is loaded. Pair with
    async_release_door_action_listener() in async_unload_entry.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    state = domain_data.setdefault(_LISTENER_KEY, {"unsub": None, "refcount": 0})
    state["refcount"] += 1
    if state["unsub"] is None:
        state["unsub"] = await mqtt.async_subscribe(
            hass, MQTT_DOOR_ACTION_TOPIC, _build_message_handler(hass), qos=1
        )
        _LOGGER.debug("Suscrito a %s", MQTT_DOOR_ACTION_TOPIC)


async def async_release_door_action_listener(hass: HomeAssistant) -> None:
    """Release one reference; unsubscribe once the last config entry using it is gone."""
    domain_data = hass.data.get(DOMAIN, {})
    state = domain_data.get(_LISTENER_KEY)
    if not state:
        return
    state["refcount"] -= 1
    if state["refcount"] <= 0 and state["unsub"] is not None:
        state["unsub"]()
        state["unsub"] = None
        _LOGGER.debug("Baja la suscripcion a %s (sin entradas activas)", MQTT_DOOR_ACTION_TOPIC)


def _build_message_handler(hass: HomeAssistant):
    @callback
    def _handle_message(msg: "mqtt.ReceiveMessage") -> None:
        hass.async_create_task(_async_dispatch(hass, msg.payload))

    return _handle_message


async def _async_dispatch(hass: HomeAssistant, raw_payload: str) -> None:
    try:
        payload = json.loads(raw_payload)
    except (TypeError, ValueError):
        _LOGGER.warning(
            "Payload no-JSON en %s (firmware antiguo publicando 'OPEN' en texto plano? "
            "actualiza el firmware): %r",
            MQTT_DOOR_ACTION_TOPIC,
            raw_payload,
        )
        return

    # Bug real corregido 2026-07-11 (COORDINATION.md Q25): esto descartaba CUALQUIER action !=
    # "open" sin mas, incluido el nuevo "close" que el firmware ya publica de verdad
    # `open_duration_s` segundos despues de un "open" en modo door_m=1 (main/hardtask.c::
    # open_door(), simetrico con lo que el rele fisico door_m=0 siempre hizo). Efecto real antes
    # de este fix: la luz/interruptor/cerradura configurado como `ha_e` se abria y se quedaba
    # asi para siempre, sin ningun error ni aviso - "la luz se enciende pero nunca se apaga
    # sola", reporte real de un usuario, no un caso hipotetico.
    action = payload.get("action") if isinstance(payload, dict) else None
    if action not in ("open", "close"):
        _LOGGER.debug(
            "Ignorando mensaje en %s (action=%r, solo se despachan 'open'/'close')",
            MQTT_DOOR_ACTION_TOPIC,
            action if isinstance(payload, dict) else payload,
        )
        return

    entity_id = payload.get("entity_id")
    if not entity_id or "." not in entity_id:
        _LOGGER.warning(
            "Mensaje '%s' en %s sin entity_id valido: %r", action, MQTT_DOOR_ACTION_TOPIC, payload
        )
        return

    if hass.states.get(entity_id) is None:
        _LOGGER.warning(
            "El doorbell pidio '%s' en '%s' pero esa entidad no existe en Home Assistant - "
            "revisa el campo 'ha_e' configurado en el propio dashboard/app del doorbell",
            action,
            entity_id,
        )
        return

    domain = entity_id.split(".", 1)[0]

    if action == "open":
        service_domain, service_name = DOMAIN_OPEN_SERVICE.get(domain, FALLBACK_SERVICE)
        if (service_domain, service_name) == FALLBACK_SERVICE and domain not in DOMAIN_OPEN_SERVICE:
            _LOGGER.warning(
                "Dominio '%s' (entidad %s) sin mapeo especifico de apertura en "
                "DOMAIN_OPEN_SERVICE - usando fallback %s.%s. Anade un mapeo explicito en "
                "const.py si este dominio deberia comportarse de otra forma.",
                domain,
                entity_id,
                service_domain,
                service_name,
            )
    else:  # action == "close"
        close_mapping = DOMAIN_CLOSE_SERVICE.get(domain)
        if close_mapping is None:
            # Deliberadamente SIN el warning ruidoso que si tiene "open" arriba: un dominio sin
            # cierre natural (button/scene/script, ver const.py) no es un hueco de
            # configuracion que haya que rellenar, es una propiedad real de ese dominio - loguear
            # a nivel de error/aviso aqui seria ruido, no una señal util.
            _LOGGER.debug(
                "Sin accion de cierre para el dominio '%s' (entidad %s) - action='close' "
                "ignorada sin efecto (normal para button/scene/script, ver DOMAIN_CLOSE_SERVICE "
                "en const.py)",
                domain,
                entity_id,
            )
            return
        service_domain, service_name = close_mapping

    try:
        await hass.services.async_call(
            service_domain, service_name, {"entity_id": entity_id}, blocking=False
        )
    except ServiceNotFound:
        _LOGGER.error(
            "Servicio %s.%s no existe - no se pudo '%s' %s",
            service_domain,
            service_name,
            action,
            entity_id,
        )
