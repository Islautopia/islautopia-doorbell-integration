"""Manual recording (REC), held open for as long as the recording actually lasts.

## Why a switch and not a button (Iñaki, 2026-09-25, fixing the Phase 0 finding)

REC works over the doorbell's signalling channel like a quick reply (§1.4-quater), but a manual
recording started that way **stops the moment the session that pressed it ends** - measured on
the Waveshare (fw 0.100.0): `rec_state:false` right after the `bye` of a one-shot command. A
`button` fires and forgets; REC needs something held open for as long as the recording runs, and
a `switch` is the entity that has an on/off lifetime instead of a single press. Turning it on
opens the session and sends `rec_start`; turning it off sends `rec_stop` and closes it - see
rec_session.py, which is where the session actually lives.

## Why `is_on` reads the session's `recording`, never "is a session held"

Holding the session open is the MECHANISM, not the fact this entity reports. If the doorbell
refuses (`admin_required`, `no_sd`, `busy`) or ends the recording on its own (the 10-minute cap,
an admin stopping it from elsewhere, a ring taking the slot for a call), the switch has to show
that immediately - a switch that reads "on" because a session happens to be open, while the
doorbell has long since stopped writing, is exactly the false "recording" state that would send
someone away thinking a moment was captured when nothing was.
"""
from __future__ import annotations

import logging

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from . import api
from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity
from .rec_session import RecSession

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([ManualRecordingSwitch(c)])


class ManualRecordingSwitch(DoorbellEntity, SwitchEntity):
    """REC. Admin-only on the doorbell's side (§1.4-quater) - reactive here, like play_audio/
    play_sequence (services.py): the doorbell's own `admin_required` becomes a HomeAssistantError
    instead of being pre-guessed from a role this integration does not otherwise track.
    """

    _attr_translation_key = "rec"
    _attr_icon = "mdi:record-rec"

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "rec")
        self._session: RecSession | None = None

    @property
    def is_on(self) -> bool:
        return self._session is not None and self._session.recording

    @property
    def extra_state_attributes(self) -> dict | None:
        # kind/origin are the firmware's own protocol vocabulary (§1.4-quater: call/detection/
        # manual, auto/manual) - technical, so left exactly as the doorbell sends them (project
        # language policy: internal protocol state stays in English, translated or not).
        if self._session is None:
            return None
        return {"kind": self._session.kind, "origin": self._session.origin}

    async def async_turn_on(self, **kwargs) -> None:
        if self._session is not None and self._session.recording:
            return  # already recording - a second rec_start would just be an extra round trip
        sesion = self.coordinator.sesion
        session = RecSession(
            sesion, self.coordinator.device_id, self.coordinator.credential, self._actualizado,
        )
        try:
            await session.start()
        except api.DoorbellApiError as err:
            # Somebody may be relying on this to actually capture the moment - a refusal that
            # silently did nothing would be worse than an error (§1.8's reasoning, same family).
            raise HomeAssistantError(f"Could not start recording: {err}") from err
        self._session = session
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        session, self._session = self._session, None
        if session is not None:
            await session.stop()
        self.async_write_ha_state()

    @callback
    def _actualizado(self) -> None:
        """Called by the held RecSession on every `rec_state` push and on its own close."""
        if self._session is not None and self._session.closed:
            self._session = None
        self.async_write_ha_state()

    async def async_will_remove_from_hass(self) -> None:
        """No leaks on reload/unload: an open REC session is closed, freeing its slot."""
        session, self._session = self._session, None
        if session is not None:
            await session.stop()
