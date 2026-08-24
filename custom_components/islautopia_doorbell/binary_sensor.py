"""Presencia y paquete, y dos de diagnostico.

## ⚠️ POR QUE ESTOS DOS SE APAGAN SOLOS Y EL OTRO NO

MQTT publicaba `videoportero/persona` con ON y OFF: el portero decia cuando alguien llegaba **y
cuando la zona quedaba despejada**. El webhook lleva EVENTOS (§3.6.1), que son flancos, y en §1.16
hay un `visitor` -- «hay alguien»-- y **no hay ningun «ya no hay nadie»**.

Asi que un sensor de visitante alimentado por eventos se quedaria encendido para siempre. Se apaga
solo pasado un rato, que es lo que hace cualquier sensor de movimiento de Home Assistant y lo que
el usuario ya espera de uno.

**El paquete NO lleva plazo, y esa asimetria es deliberada**: ahi §1.16 SI tiene la pareja completa
(`package` y `package_gone`), asi que apagarlo por tiempo seria inventarse un final que el portero
ya sabe decir -- y peor, apagaria un paquete que sigue en el felpudo. Un paquete es un objeto
quieto: se queda horas.
"""
from __future__ import annotations

import logging

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, SIGNAL_EVENTO
from .coordinator import DoorbellCoordinator
from .entity import DoorbellEntity

_LOGGER = logging.getLogger(__name__)

# Cuanto aguanta encendido el sensor de visitante sin noticias. Del orden del plazo de gracia que
# el propio portero usa para dar la zona por despejada y cerrar la grabacion.
SEGUNDOS_VISITANTE = 30


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        VisitanteBinarySensor(c),
        PaqueteBinarySensor(c),
        PresenciaBinarySensor(c, "panel", "Panel de calle", "mdi:tablet"),
        PresenciaBinarySensor(c, "reader", "Lector de huellas", "mdi:fingerprint"),
    ])


class _PorEventos(DoorbellEntity, BinarySensorEntity):
    """Base de los que viven de lo que empuja el webhook."""

    def __init__(self, coordinator: DoorbellCoordinator, clave: str) -> None:
        super().__init__(coordinator, clave)
        self._attr_is_on = False

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
        raise NotImplementedError


class VisitanteBinarySensor(_PorEventos):
    """Alguien en la puerta. Se apaga solo -- ver la cabecera del modulo."""

    _attr_name = "Visitante"
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "visitante")
        self._cancelar_apagado = None

    @callback
    def _recibido(self, sobre: dict) -> None:
        if sobre.get("ev") != "visitor":
            return
        self._attr_is_on = True
        self.async_write_ha_state()

        # Cada aviso REARMA el plazo en vez de sumar uno nuevo. Sin esto, una persona que se queda
        # cinco minutos generaria un apagado por cada evento y el sensor parpadearia.
        if self._cancelar_apagado is not None:
            self._cancelar_apagado()

        @callback
        def _apagar(_now) -> None:
            self._cancelar_apagado = None
            self._attr_is_on = False
            self.async_write_ha_state()

        self._cancelar_apagado = async_call_later(self.hass, SEGUNDOS_VISITANTE, _apagar)

    async def async_will_remove_from_hass(self) -> None:
        if self._cancelar_apagado is not None:
            self._cancelar_apagado()
            self._cancelar_apagado = None
        await super().async_will_remove_from_hass()


class PaqueteBinarySensor(_PorEventos):
    """Un paquete a la vista. SIN plazo -- ver la cabecera del modulo."""

    _attr_name = "Paquete en la puerta"
    _attr_icon = "mdi:package-variant-closed"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "paquete")

    @callback
    def _recibido(self, sobre: dict) -> None:
        ev = sobre.get("ev")
        if ev == "package":
            self._attr_is_on = True
        elif ev == "package_gone":
            self._attr_is_on = False
        else:
            return
        self.async_write_ha_state()


class PresenciaBinarySensor(DoorbellEntity, BinarySensorEntity):
    """`panel` y `reader` de §1.19: se DESCUBREN, no se configuran.

    No existe ningun ajuste de «tengo panel», y es deliberado: solo podria estar equivocado, y lo
    estaria justo el dia que alguien cambia el cableado. El portero lo publica en cada sondeo, asi
    que aparece y desaparece solo -- incluido mientras el panel se reinicia durante su propia
    actualizacion.

    ⚠️ `reader` a 0 agrupa TRES cosas -- no hay lector, no hay panel, o el panel no puede
    afirmarlo-- y falla cerrado a proposito, porque las tres llevan a la misma decision: no ofrecer
    la gestion de huellas. El matiz esta en `reader_state` de `firmware_info`.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: DoorbellCoordinator, campo: str, nombre: str, icono: str) -> None:
        super().__init__(coordinator, campo)
        self._campo = campo
        self._attr_name = nombre
        self._attr_icon = icono

    @property
    def is_on(self) -> bool:
        return bool((self.coordinator.data or {}).get(self._campo, 0))
