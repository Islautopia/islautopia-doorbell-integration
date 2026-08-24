"""Base comun de las entidades: identidad, disponibilidad y el enganche al webhook."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import DoorbellCoordinator


class DoorbellEntity(CoordinatorEntity[DoorbellCoordinator]):
    """Toda entidad de un portero cuelga de aqui."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: DoorbellCoordinator, clave: str) -> None:
        super().__init__(coordinator)
        self._clave = clave
        self._attr_unique_id = f"{coordinator.device_id}_{clave}"

    @property
    def device_info(self) -> DeviceInfo:
        """Se enganchan al MISMO dispositivo que ya registra __init__.py.

        ⚠️ Y aqui va SOLO nuestro identificador, no el que usaba el autodiscovery de MQTT. El
        segundo lo pone `__init__.py` a proposito, para que Home Assistant fusionara nuestro
        dispositivo con el que MQTT hubiera creado para el mismo portero fisico. MQTT se retiro
        (§4), asi que ya no hay nada con lo que fusionarse -- pero ese identificador se queda alli
        para que un Home Assistant que todavia arrastre las entidades viejas de MQTT no acabe con
        dos dispositivos desconectados para el mismo aparato.
        """
        datos = self.coordinator.data or {}
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.device_id)},
            manufacturer="Islautopia",
            model=f"IG Doorbell {datos.get('hw_version', '')}".strip(),
            name=self.coordinator.nombre_portero,
            sw_version=datos.get("fw_version"),
            configuration_url=f"https://{self.coordinator.device_id}.doorbell.islautopia.com:8443/",
        )

    @property
    def available(self) -> bool:
        """Disponible = el ultimo sondeo respondio.

        Esto es lo que sustituye al LWT de MQTT, y sale gratis: con el broker habia que configurar
        un mensaje postumo, o sea una pieza mas que podia quedarse sin configurar y dejar entidades
        diciendo un estado de hace horas.
        """
        return self.coordinator.last_update_success
