"""WebSocket API bridge between this integration and the Lovelace card.

The card asks Home Assistant for what it needs over the authenticated WebSocket the frontend
already uses (`hass.connection.sendMessagePromise(...)`), gated by the normal HA user session.

⚠️ WHAT THE CARD NEVER GETS (Phase 0, 2026-09-25): the pairing credential, the relay URL, TURN
credentials. Until 0.6.x `get_connection_info` returned the credential to the browser of every HA
user who opened a dashboard, and the card used it to talk to the doorbell's public hostname and to
the cloud relay. The card now talks ONLY to this Home Assistant (signal_proxy.py,
recordings_view.py), which adds the credential server-side and reaches the doorbell over the LAN.

Two commands:
  - islautopia_doorbell/get_connection_info: the device id and the entity ids the card reads
    (the live-view timeout `number` and the events `event`, so a ring can wake a paused card).
  - islautopia_doorbell/get_local_signal_url: a short-lived signed URL for the signalling proxy.
"""
from __future__ import annotations

import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .const import CONF_DEVICE_ID, DOMAIN
from .signal_proxy import async_signed_signal_url

_LOGGER = logging.getLogger(__name__)


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the WS commands. Safe to call more than once (HA dedupes by name)."""
    websocket_api.async_register_command(hass, websocket_get_connection_info)
    websocket_api.async_register_command(hass, websocket_get_local_signal_url)


def _find_entry_data(hass: HomeAssistant, device_id: str) -> dict | None:
    """Find the stored data for a paired doorbell, by its device id.

    This asks Home Assistant which config entries actually exist and looks each one up by id,
    instead of walking everything stored under our domain key and accepting whatever happens to
    look like a config entry.

    Y la distincion importa. El diccionario que hay bajo cada `entry_id` no es solo
    `entry.data`: lleva ademas objetos vivos (el coordinador, el identificador del webhook).
    Recorrer los VALORES de `hass.data[DOMAIN]` buscando un `device_id` funcionaria hoy por
    casualidad, y coincidiria en silencio con cualquier cosa que alguien guarde ahi manana con ese
    campo dentro. Preguntar a Home Assistant que entradas existen no tiene esa propiedad.

    Lo escribio antes el escucha compartido de MQTT, que vivia bajo esa misma clave y solo se
    libraba de coincidir porque no llevaba ningun `device_id` -- suerte, no diseno. MQTT se retiro
    (contrato §4) y el argumento se mantiene entero, ahora contra el propio coordinador.
    """
    stored = hass.data.get(DOMAIN, {})
    for entry in hass.config_entries.async_entries(DOMAIN):
        entry_data = stored.get(entry.entry_id)
        if isinstance(entry_data, dict) and entry_data.get(CONF_DEVICE_ID) == device_id:
            return entry_data
    return None


@websocket_api.websocket_command(
    {
        vol.Required("type"): "islautopia_doorbell/get_connection_info",
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_get_connection_info(hass: HomeAssistant, connection, msg) -> None:
    """What the card needs besides signalling: which entities of this doorbell to read.

    ⚠️ No credential and no relay URL here, on purpose (module docstring). A test asserts it.
    """
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    device_id = entry_data[CONF_DEVICE_ID]
    registro = er.async_get(hass)
    connection.send_result(
        msg["id"],
        {
            "device_id": device_id,
            "live_timeout_entity": registro.async_get_entity_id(
                "number", DOMAIN, f"{device_id}_live_timeout"
            ),
            "events_entity": registro.async_get_entity_id("event", DOMAIN, f"{device_id}_eventos"),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "islautopia_doorbell/get_local_signal_url",
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_get_local_signal_url(hass: HomeAssistant, connection, msg) -> None:
    """Return a short-lived signed URL for the local signalling proxy (see signal_proxy.py).

    Signed rather than plain because `EventSource` cannot send an Authorization header - the same
    limitation that made the firmware accept `?token=` in its query string. This is how Home
    Assistant's own camera streams solve it.

    Since Phase 0 this is the card's only signalling path (no public hostname, no relay).

    Only signalling goes through the proxy. Media stays peer-to-peer over UDP straight to the
    doorbell's LAN address, which Private Relay does not touch.
    """
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    connection.send_result(
        msg["id"],
        {
            "device_id": entry_data[CONF_DEVICE_ID],
            "signal_url": async_signed_signal_url(hass, entry_data[CONF_DEVICE_ID]),
        },
    )
