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
    """Normal / Away / Do not disturb / Custom -- states are translation keys (const.MODOS)."""

    _attr_translation_key = "mode"
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
            raise HomeAssistantError(f"Unknown mode: {option}")

        # The doorbell's LAN session (net.py): works with the internet down, never via the VPS.
        sesion = self.coordinator.sesion
        try:
            # Guardado PARCIAL: solo `m`. Mandar el estado entero convertiria cualquier lectura de
            # hace 30 s en una escritura que pisa lo que otro acaba de cambiar desde el dashboard.
            await api.async_save_states(
                sesion, self.coordinator.device_id, self.coordinator.credential, {"m": str(numero)}
            )
        except api.NotAllowedError as err:
            raise HomeAssistantError(
                "This pairing is not an administrator of the doorbell, so it cannot change the "
                "mode. Re-pair it from an administrator account."
            ) from err
        except api.DoorbellApiError as err:
            raise HomeAssistantError(f"Could not change the mode: {err}") from err

        # CONFIRMED AT ONCE, NOT ON THE NEXT POLL (0.7.4, Inaki 2026-09-25: "the mode button is
        # quite lazy showing the new mode... sometimes it looks like it did not work").
        #
        # Until 0.7.3 this was `async_request_refresh()`. That goes through the coordinator's
        # DEBOUNCER (10 s cooldown): the first change after a quiet spell refreshed at once, but a
        # second change within 10 s waited out the cooldown, and a failed read waited for the
        # 30 s poll -- the select kept showing the OLD mode meanwhile, which reads as "it did not
        # work". Now the doorbell is read directly, right after the write, and what it says is
        # published to every entity immediately (async_set_updated_data).
        #
        # Still not "assume the new value": the doorbell owns the state. save_states ignores a
        # field it does not accept WITHOUT an error status (contract 1.2), so only the read-back
        # tells "applied" from "silently dropped". If it was dropped, the entity keeps showing
        # the doorbell's real mode AND the service call fails with a readable reason, so the card
        # (or whoever called it) can say so instead of failing in silence.
        try:
            estado = await api.async_get_states(
                sesion, self.coordinator.device_id, self.coordinator.credential
            )
        except api.DoorbellApiError:
            # The write was accepted (200) but the read-back failed: fall back to the normal
            # refresh rather than claiming a failure that did not happen.
            await self.coordinator.async_request_refresh()
            return
        self.coordinator.async_set_updated_data({**(self.coordinator.data or {}), **estado})
        try:
            aplicado = int(estado.get("m")) == numero
        except (TypeError, ValueError):
            aplicado = False
        if not aplicado:
            raise HomeAssistantError(
                f"The doorbell did not apply the mode '{option}' (it reports "
                f"'{MODOS.get(estado.get('m'), estado.get('m'))}')."
            )
