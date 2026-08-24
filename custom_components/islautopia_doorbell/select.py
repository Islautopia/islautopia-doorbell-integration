"""El modo del portero (§1.2, campo `m`).

Gobierna que hace el aparato al llamar --que suena, que se ve en el anillo, y si se avisa a los
telefonos (§3.5)-- asi que es de lo poco del portero que un usuario de Home Assistant quiere
automatizar de verdad: «en No molestar a las 23:00» es una automatizacion de dos lineas.

## ⚠️ Cambiarlo EXIGE que el emparejamiento sea de administrador

`save_states` pide rol admin (§1.16-bis: lo que se lee es de cualquiera, lo que escribe en el
portero es de administrador). Un emparejamiento que no lo sea puede LEER el modo y no cambiarlo, y
el `403` se traduce a un error visible en vez de un no-op silencioso.
"""
from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN, MODOS
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([ModoSelect(c)])


class ModoSelect(DoorbellEntity, SelectEntity):
    """Normal / Ausente / No molestar / Custom."""

    _attr_name = "Modo"
    _attr_icon = "mdi:home-clock"
    _attr_options = list(MODOS.values())

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "modo")

    @property
    def current_option(self) -> str | None:
        """El modo vigente, o None si el portero devuelve uno que no conocemos.

        `None` y no un texto inventado: un modo nuevo del firmware debe verse como «no lo se» y no
        como «Normal», que seria afirmar algo falso sobre el aparato de la puerta.
        """
        return MODOS.get((self.coordinator.data or {}).get("m"))

    async def async_select_option(self, option: str) -> None:
        numero = next((k for k, v in MODOS.items() if v == option), None)
        if numero is None:
            raise HomeAssistantError(f"Modo desconocido: {option}")

        # La sesion de este portero: prueba su direccion local antes que el DNS publico
        # (net.py), asi que esto sigue funcionando con la linea caida.
        sesion = self.coordinator.sesion
        try:
            # Guardado PARCIAL: solo `m`. Mandar el estado entero convertiria cualquier lectura de
            # hace 30 s en una escritura que pisa lo que otro acaba de cambiar desde el dashboard.
            await api.async_save_states(
                sesion, self.coordinator.device_id, self.coordinator.credential, {"m": str(numero)}
            )
        except api.NotAllowedError as err:
            raise HomeAssistantError(
                "Este emparejamiento no es administrador de ese portero, asi que no puede cambiar "
                "el modo. Vuelve a emparejarlo desde una sesion de administrador."
            ) from err
        except api.DoorbellApiError as err:
            raise HomeAssistantError(f"No se pudo cambiar el modo: {err}") from err

        # Se refresca en vez de dar por hecho el valor nuevo. El portero es el dueno del estado, y
        # asumirlo dejaria la entidad mintiendo si la escritura no llego a aplicarse.
        await self.coordinator.async_request_refresh()
