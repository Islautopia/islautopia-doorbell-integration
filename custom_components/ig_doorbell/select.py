"""The doorbell's mode (§1.2, field `m`).

Governs what the device does when it rings - what sounds, what shows on the ring, and whether
phones are notified (§3.5) - so it is one of the few things about the doorbell a Home Assistant
user actually wants to automate: "do not disturb at 23:00" is a two-line automation.

## ⚠️ Changing it REQUIRES the pairing to be an administrator

`save_states` requires the admin role (§1.16-bis: reading is open to anyone, writing to the
doorbell is administrator-only). A pairing that is not one can READ the mode and not change it,
and the `403` is translated into a visible error instead of a silent no-op.
"""
from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN, MODES
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([ModeSelect(c)])


class ModeSelect(DoorbellEntity, SelectEntity):
    """Normal / Away / Do not disturb / Custom -- states are translation keys (const.MODES)."""

    _attr_translation_key = "mode"
    _attr_icon = "mdi:home-clock"
    _attr_options = list(MODES.values())

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "mode")

    @property
    def current_option(self) -> str | None:
        """The current mode, or None if the doorbell returns one we do not know.

        `None` and not a made-up label: a mode new to the firmware must read as "I don't know",
        not as "Normal", which would assert something false about the device at the door.
        """
        return MODES.get((self.coordinator.data or {}).get("m"))

    async def async_select_option(self, option: str) -> None:
        number = next((k for k, v in MODES.items() if v == option), None)
        if number is None:
            raise HomeAssistantError(f"Unknown mode: {option}")

        # The doorbell's LAN session (net.py): works with the internet down, never via the VPS.
        session = self.coordinator.session
        try:
            # PARTIAL save: only `m`. Sending the whole state would turn any reading up to 30 s
            # stale into a write that stomps whatever someone else just changed from the dashboard.
            await api.async_save_states(
                session, self.coordinator.device_id, self.coordinator.credential, {"m": str(number)}
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
            state = await api.async_get_states(
                session, self.coordinator.device_id, self.coordinator.credential
            )
        except api.DoorbellApiError:
            # The write was accepted (200) but the read-back failed: fall back to the normal
            # refresh rather than claiming a failure that did not happen.
            await self.coordinator.async_request_refresh()
            return
        self.coordinator.async_set_updated_data({**(self.coordinator.data or {}), **state})
        try:
            applied = int(state.get("m")) == number
        except (TypeError, ValueError):
            applied = False
        if not applied:
            raise HomeAssistantError(
                f"The doorbell did not apply the mode '{option}' (it reports "
                f"'{MODES.get(state.get('m'), state.get('m'))}')."
            )
