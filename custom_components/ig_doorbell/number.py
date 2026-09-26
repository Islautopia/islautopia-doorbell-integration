"""Live view timeout: how long the card keeps the live stream without anyone touching it.

## Why it exists (Iñaki, 2026-09-25)

A very common Home Assistant automation brings the doorbell card to the front of a wall panel when
someone rings. That leaves a client connected to the doorbell 24x7 for no one: it keeps a WebRTC
slot (four for the whole house) and the doorbell encrypting video nobody watches. The apps solve the
same thing when they go to the background (`live_pause`, then hang up after a grace period, §1.4-bis
"Live pause"); the card now does the same after this many seconds without interaction.

## Why an entity here and not a card option

So an automation or any dashboard can change it ("no timeout while we are on holiday", "short at
night"). The integration only HOLDS the value; **the card applies it**, because the card is the one
with the session. Never during an active call or with the microphone open (§1.4-bis rule), and a
new ring wakes a paused card by itself.

## The default: 120 s, and why

- Long enough for the normal use of a ring-triggered panel: look, recognise, walk to the panel or
  open the door. A visitor rarely waits more than a minute or two, and a conversation keeps the
  session alive on its own (the microphone vetoes the timeout).
- Short enough that a panel nobody looks at frees its slot within two minutes, well inside the
  window in which a second ring or another member of the house would need it.
- It is also longer than the doorbell's own 20 s abandonment deadline and the apps' 15 s background
  grace, so the card is never the most aggressive client in the house.

`0` disables the timeout (a phone dashboard, where the user closes the view anyway).
"""
from __future__ import annotations

from homeassistant.components.number import NumberMode, RestoreNumber
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LIVE_TIMEOUT_DEFAULT_S, LIVE_TIMEOUT_MAX_S
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([LiveTimeoutNumber(c)])


class LiveTimeoutNumber(DoorbellEntity, RestoreNumber):
    """Seconds without interaction before the card stops the live stream and frees the slot."""

    _attr_translation_key = "live_view_timeout"
    _attr_icon = "mdi:timer-pause-outline"
    _attr_entity_category = EntityCategory.CONFIG
    _attr_native_min_value = 0
    _attr_native_max_value = LIVE_TIMEOUT_MAX_S
    _attr_native_step = 15
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "live_timeout")
        self._attr_native_value = float(LIVE_TIMEOUT_DEFAULT_S)

    @property
    def available(self) -> bool:
        # A Home Assistant setting, not a doorbell reading: it stays usable (and readable by the
        # card) while the doorbell is off. An unavailable value would make every card fall back to
        # its own default, silently ignoring what the owner set.
        return True

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        previous = await self.async_get_last_number_data()
        if previous is not None and previous.native_value is not None:
            self._attr_native_value = previous.native_value

    async def async_set_native_value(self, value: float) -> None:
        self._attr_native_value = value
        self.async_write_ha_state()
