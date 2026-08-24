"""Sensores del portero: espectadores, y los de diagnostico."""
from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import DoorbellCoordinator
from .entity import DoorbellEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    c: DoorbellCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    async_add_entities([
        EspectadoresSensor(c),
        TextoSensor(c, "fw_version", "Version de firmware", "mdi:chip"),
        TextoSensor(c, "panel_fw", "Firmware del panel", "mdi:tablet"),
    ])


class EspectadoresSensor(DoorbellEntity, SensorEntity):
    """`webrtc_clients` (§1.2): cuanta gente esta mirando ahora mismo, 0-4.

    Cuenta SOLO sesiones WebRTC, incluidas las que todavia negocian ICE/DTLS. Los clientes RTSP no
    cuentan: son NVR de terceros, no usuarios.

    ⚠️ Hasta 30 s de retraso, y no es un defecto que arreglar bajando el sondeo. El contador cambia
    en sitios que corren en el camino de tiempo real del audio y el video del portero, asi que
    preguntarselo mas a menudo le cuesta a el lo que a nosotros nos ahorra. **Para automatizar en
    vivo esta la entidad de eventos**, que llega empujada.
    """

    _attr_name = "Espectadores"
    _attr_icon = "mdi:account-eye"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: DoorbellCoordinator) -> None:
        super().__init__(coordinator, "espectadores")

    @property
    def native_value(self) -> int:
        return int((self.coordinator.data or {}).get("webrtc_clients", 0))


class TextoSensor(DoorbellEntity, SensorEntity):
    """Un campo de texto de diagnostico.

    ⚠️ `panel_fw` **solo aparece si hay panel** (§1.2-ter), y su ausencia significa «no hay panel»,
    no «no se sabe». Se devuelve `None` en ese caso en vez de una cadena vacia o un guion: un
    cliente que pinte «-» esta afirmando algo que el portero nunca dijo.
    """

    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, coordinator: DoorbellCoordinator, campo: str, nombre: str, icono: str) -> None:
        super().__init__(coordinator, campo)
        self._campo = campo
        self._attr_name = nombre
        self._attr_icon = icono

    @property
    def native_value(self) -> str | None:
        return (self.coordinator.data or {}).get(self._campo) or None
