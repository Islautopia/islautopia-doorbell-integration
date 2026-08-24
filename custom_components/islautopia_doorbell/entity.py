"""Base comun de las entidades: identidad, disponibilidad y el enganche al webhook."""
from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo

# ⚠️ El callback con el que una plataforma da de alta sus entidades CAMBIO DE NOMBRE: Home
# Assistant introdujo `AddConfigEntryEntitiesCallback` y dejo `AddEntitiesCallback` en desuso. Se
# importa el nuevo y se cae al viejo, y se re-exporta desde aqui para que las cinco plataformas no
# repitan el mismo bloque -- una defensa repartida en cinco sitios se cae en cuanto uno se queda
# atras, y aqui el modo de fallo es que la integracion **no carga**, sin nada que lo explique.
try:  # HA >= 2025.2
    from homeassistant.helpers.entity_platform import (
        AddConfigEntryEntitiesCallback as AddEntities,
    )
except ImportError:  # pragma: no cover - HA anterior
    from homeassistant.helpers.entity_platform import AddEntitiesCallback as AddEntities
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

        Un solo identificador, el nuestro, igual que en `__init__.py`. Hubo un segundo -- el del
        autodescubrimiento de MQTT-- para que Home Assistant fusionara los dos dispositivos; se
        retiro el 2026-08-24 al medirse lo que costaba: borrar el dispositivo de MQTT se llevaba
        nuestra entrada de configuracion. El porque entero esta en `__init__.py`.
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
