"""Open the door.

## Why a button and not a switch

Because the doorbell **does not know whether the door is open**. A switch has state and this one
would have nothing to report: it would sit on or off depending on whoever last pressed it, which
is a claim nobody made. A button is honest - it is pressed, it happens, and it does not pretend to
know anything afterwards.

## ⚠️ §1.8's double-tap is NOT implemented here, and it is not an oversight

That rule protects against an accidental touch **on a client's screen**: a phone in a pocket, a
child, a bouncing finger. A Home Assistant button is pressed from a dashboard or from an
automation, and an automation does not fat-finger it. Adding a confirmation here would make it
unusable from an automation, which is exactly what this entity exists for.

What IS honoured from §1.8 is the other half: **if `door_m=2` the button is not drawn**.
"""
from __future__ import annotations

import logging

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    if not c.has_lock:
        # NOT drawn disabled: not drawn at all. This is the rule the contract applies to the open
        # button with `door_m=2` (§1.4-ter), to the Keys row with no panel (§1.20), and to
        # non-notifiable events (§3.6.4) - offering a control that cannot work is worse than not
        # offering it.
        _LOGGER.info("That doorbell has no lock configured (door_m=2): no open button")
        return
    async_add_entities([OpenDoorButton(c)])


class OpenDoorButton(DoorbellEntity, ButtonEntity):
    """Opens the door."""

    _attr_translation_key = "open_door"
    _attr_icon = "mdi:door-open"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "open")

    async def async_press(self) -> None:
        # The doorbell's LAN session (net.py): works with the internet down, never via the VPS.
        session = self.coordinator.session
        try:
            await api.async_open_door(session, self.coordinator.device_id, self.coordinator.credential)
        except api.NoLockConfiguredError as err:
            # This can be reached even though the entity exists: `door_m` may have changed since
            # the last poll. What happened is stated, not a code (§1.0 point 5).
            raise HomeAssistantError("That doorbell no longer has a lock configured") from err
        except api.DoorbellApiError as err:
            # ⚠️ A failure is PROPAGATED, never swallowed. Someone may be waiting outside, and a
            # button that is pressed and says nothing reads as the door having opened (§1.8: a
            # timeout is a timeout, never an "opened").
            raise HomeAssistantError(f"Could not open the door: {err}") from err
