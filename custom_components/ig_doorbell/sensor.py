"""Doorbell sensors: viewers, and the diagnostic ones."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.const import EntityCategory

from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import AddEntities, DoorbellEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntities
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        ViewersSensor(c),
        TextSensor(c, "fw_version", "firmware_version", "mdi:chip"),
        TextSensor(c, "panel_fw", "panel_firmware", "mdi:tablet"),
    ])


class ViewersSensor(DoorbellEntity, SensorEntity):
    """`webrtc_clients` (§1.2): how many people are watching right now, 0-4.

    Counts ONLY WebRTC sessions, including ones still negotiating ICE/DTLS. RTSP clients do not
    count: they are third-party NVRs, not users.

    ⚠️ Up to 30 s of lag, and that is not a defect to fix by polling more often. The counter changes
    in places that run on the doorbell's real-time audio/video path, so asking more often costs it
    exactly what it would save us. **The events entity is there for live automation**, and it
    arrives pushed.
    """

    _attr_translation_key = "viewers"
    _attr_icon = "mdi:account-eye"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "viewers")

    @property
    def native_value(self) -> int:
        return int((self.coordinator.data or {}).get("webrtc_clients", 0))


class TextSensor(DoorbellEntity, SensorEntity):
    """A diagnostic text field.

    ⚠️ `panel_fw` **only appears if there is a panel** (§1.2-ter), and its absence means "no
    panel", not "not known". `None` is returned in that case instead of an empty string or a dash:
    a client that paints "-" is asserting something the doorbell never said.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: DoorbellCoordinator, field: str, translation_key_name: str, icon: str) -> None:
        super().__init__(coordinator, field)
        self._field = field
        self._attr_translation_key = translation_key_name
        self._attr_icon = icon

    @property
    def native_value(self) -> str | None:
        return (self.coordinator.data or {}).get(self._field) or None
