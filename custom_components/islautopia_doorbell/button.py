"""Abrir la puerta.

## Por que un boton y no un interruptor

Porque el portero **no sabe si la puerta esta abierta**. Un interruptor tiene estado y este no
tendria ninguno que decir: quedaria encendido o apagado segun lo ultimo que alguien pulso, que es
una afirmacion que nadie ha hecho. Un boton es honesto -- se pulsa, ocurre, y no finge saber nada
despues.

## ⚠️ La doble pulsacion de §1.8 NO se implementa aqui, y no es un olvido

Esa regla protege contra el toque accidental **en la pantalla de un cliente**: un movil en el
bolsillo, un nino, un dedo que rebota. Un boton de Home Assistant se pulsa desde un dashboard o
desde una automatizacion, y una automatizacion no se equivoca de dedo. Meter una confirmacion aqui
la haria imposible de usar desde una automatizacion, que es justo para lo que existe esta entidad.

Lo que si se respeta es lo otro de §1.8: **si `door_m=2` el boton no se dibuja**.
"""
from __future__ import annotations

import logging

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import api
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    if not c.tiene_cerradura:
        # NO se dibuja apagado: no se dibuja. Es la regla que este contrato aplica al boton de
        # abrir con `door_m=2` (§1.4-ter), a la fila de Llaves sin panel (§1.20) y a los eventos no
        # notificables (§3.6.4) -- ofrecer un control que no puede funcionar es peor que no
        # ofrecerlo.
        _LOGGER.info("Ese portero no tiene cerradura configurada (door_m=2): sin boton de abrir")
        return
    async_add_entities([AbrirPuertaButton(c)])


class AbrirPuertaButton(DoorbellEntity, ButtonEntity):
    """Abre la puerta."""

    _attr_name = "Abrir puerta"
    _attr_icon = "mdi:door-open"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "abrir")

    async def async_press(self) -> None:
        sesion = async_get_clientsession(self.hass)
        try:
            await api.async_open_door(sesion, self.coordinator.device_id, self.coordinator.credential)
        except api.NoLockConfiguredError as err:
            # Se puede llegar aqui aunque la entidad exista: `door_m` pudo cambiar desde el ultimo
            # sondeo. Se dice lo que pasa, no un codigo (§1.0 punto 5).
            raise HomeAssistantError(
                "Ese portero ya no tiene cerradura configurada"
            ) from err
        except api.DoorbellApiError as err:
            # ⚠️ Un fallo se PROPAGA, nunca se traga. Hay alguien esperando fuera, y un boton que
            # se pulsa y no dice nada se lee como que la puerta se abrio (§1.8: un tiempo agotado
            # es un tiempo agotado, nunca un "abierta").
            raise HomeAssistantError(f"No se pudo abrir la puerta: {err}") from err
