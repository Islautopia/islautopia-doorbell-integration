"""UNA entidad de evento que lleva TODO lo que el portero puede contar (§1.16).

## Por que una sola, y no una por evento

Porque el catalogo crece. §1.16 tiene hoy 24 entradas y ya ha crecido tres veces este mes, y una
entidad por evento significa que **una funcion nueva del portero es invisible hasta que alguien
actualice esta integracion**. Con una sola entidad y la lista de tipos abierta, un evento que este
codigo no conozca llega igual y se puede automatizar el mismo dia.

Es ademas lo que Home Assistant espera de algo momentaneo: un timbrazo no tiene estado, tiene
instante. Modelarlo como un `binary_sensor` que se enciende y se apaga obliga a inventarse cuanto
dura -- y quien mire medio segundo tarde no ve nada.

## Lo que NO hace

No filtra. El unico evento que se descarta aqui es `hass_action`, y no es un evento: es una orden
(§4), que ni sale en la campanita ni deberia salir aqui -- seria una entrada por cada bombilla.
"""
from __future__ import annotations

import logging

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_EVENTO
from .coordinator import DoorbellCoordinator
from .entity import DoorbellEntity

_LOGGER = logging.getLogger(__name__)

# Los identificadores de §3.6.1. Se listan para que Home Assistant los ofrezca en el editor de
# automatizaciones -- **no para filtrar**: uno que no este aqui se acepta igual (ver `_recibido`).
TIPOS_CONOCIDOS = [
    "ring", "visitor", "package", "person_with_package", "package_gone",
    "visitor_message", "door_opened", "storage_problem", "unexpected_reboot",
    "client_paired", "user_added", "user_revoked", "login_failed",
    "mode_changed", "ring_suppressed", "viewer_joined",
    "key_denied", "key_locked",
]


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([DoorbellEventos(coordinator)])


class DoorbellEventos(DoorbellEntity, EventEntity):
    """Todo lo que ocurre en la puerta, en una entidad."""

    _attr_translation_key = "eventos"
    _attr_name = "Eventos"
    _attr_icon = "mdi:bell-ring-outline"
    _attr_event_types = TIPOS_CONOCIDOS

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "eventos")

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_EVENTO.format(device_id=self.coordinator.device_id),
                self._recibido,
            )
        )

    @callback
    def _recibido(self, sobre: dict) -> None:
        ev = sobre.get("ev")
        if not ev:
            return

        # Un tipo que no estaba en la lista se ANADE en caliente en vez de descartarse. Sin esto,
        # un evento nuevo del portero se perderia en silencio hasta que alguien actualizara esta
        # integracion -- y el sintoma seria "esa funcion no llega a Home Assistant", que nadie
        # relaciona con una lista de constantes.
        if ev not in self._attr_event_types:
            _LOGGER.info("Evento '%s' que esta integracion no conocia: se acepta igual", ev)
            self._attr_event_types = [*self._attr_event_types, ev]

        # Todo el sobre viaja como atributos, `d` aplanado. Es lo que hace que una automatizacion
        # pueda mirar `rec` --el clip al que lleva este aviso (§1.7-quater)-- o `by`, sin que esta
        # integracion tenga que conocer cada campo de cada evento.
        atributos = {k: v for k, v in sobre.items() if k not in ("ev", "type", "d")}
        d = sobre.get("d")
        if isinstance(d, dict):
            atributos.update(d)

        self._trigger_event(ev, atributos)
        self.async_write_ha_state()
