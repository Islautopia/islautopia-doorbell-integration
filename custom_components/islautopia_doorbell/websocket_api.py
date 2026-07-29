"""WebSocket API bridge between this integration and the Lovelace card.

The card (browser JS, `islautopia-intercom-card`) never sees the doorbell's admin
email/password, and the user never pastes any credential into YAML - the card asks Home
Assistant for what it needs over the same authenticated WebSocket connection the frontend
already uses for everything else (`hass.connection.sendMessagePromise(...)`), gated by the
normal HA user session. No new auth mechanism is invented here.

Two commands:
  - islautopia_doorbell/get_connection_info: mostly-static info (device_id, the relay WS URL,
    and the pair_app credential needed for the relay's `?token=`).
  - islautopia_doorbell/get_turn_credentials: fetched fresh, on demand, right before the card
    starts a new WebRTC session (TURN credentials are short-lived, ~1h TTL).

NOTE (2026-07-10): get_connection_info used to also resolve/return a
server-side mDNS-discovered `local_host` - removed entirely, not just made non-blocking. Two
independent reasons converged: (1) the card never actually used it to build its connection URL
(it always connects via the doorbell's public hostname, both because the real TLS certificate is
bound to that hostname and to avoid mixed-content blocking when HA itself is served over HTTPS -
see ARCHITECTURE.md §5/§7 "Q7"), and (2) mDNS is multicast and normally does not cross VLAN/subnet
boundaries without an explicit multicast relay - for any real multi-VLAN network (a common setup
for the kind of user who'd self-host Home Assistant), relying on it wouldn't just be unused, it
would be actively wrong for exactly the doorbells provisioned manually by IP because they live on
a different VLAN/subnet than the HA host. `discovery.py` (the whole mDNS-browsing module this
fed) has been deleted.
"""
from __future__ import annotations

import logging
import time

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import api
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN, RELAY_HOST

_LOGGER = logging.getLogger(__name__)


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register the two WS commands. Safe to call more than once (HA dedupes by name)."""
    websocket_api.async_register_command(hass, websocket_get_connection_info)
    websocket_api.async_register_command(hass, websocket_get_turn_credentials)


def _find_entry_data(hass: HomeAssistant, device_id: str) -> dict | None:
    for entry_data in hass.data.get(DOMAIN, {}).values():
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
    """Return everything the card needs to pick a transport and open a WebRTC session.

    The card always connects to the doorbell via its public hostname
    (`<device_id>.doorbell.islautopia.com:8443`, built client-side from `device_id` alone - see
    ARCHITECTURE.md §5) for the local path, and falls back to `relay_ws_url`
    (API_CONTRACT.md §3.2/§3.3) if that's unreachable - e.g. the dashboard is being viewed
    remotely through Nabu Casa, or (2026-07-10) the doorbell and the HA host are on different
    VLANs/subnets. No LAN address resolution happens on this side on purpose - see the module
    docstring for why an earlier `local_host` field was removed rather than kept around unused.
    """
    # Real instrumentation (2026-07-10 - a report of 10+ seconds for the card to start up):
    # logged at INFO on purpose (not debug) so it is easy to find in HA's Logs without having to
    # raise the log level, while the actual performance problem is being investigated. Drop this
    # to debug once that is closed out.
    t0 = time.monotonic()
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    device_id = entry_data[CONF_DEVICE_ID]
    elapsed_ms = round((time.monotonic() - t0) * 1000)
    _LOGGER.debug(
        "[islautopia_doorbell timing] get_connection_info for %s: %sms",
        device_id,
        elapsed_ms,
    )

    connection.send_result(
        msg["id"],
        {
            "device_id": device_id,
            "relay_ws_url": f"wss://{RELAY_HOST}/ws/client/{device_id}",
            "credential": entry_data[CONF_CREDENTIAL],
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "islautopia_doorbell/get_turn_credentials",
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_get_turn_credentials(hass: HomeAssistant, connection, msg) -> None:
    """Fetch a fresh TURN credential set (contract §3.1-bis) right before starting ICE.

    Never cached in this integration: cheap to call (single HTTPS round trip to the relay),
    and caching short-lived (TTL ~1h) credentials just adds a place for them to go stale
    unnoticed.
    """
    t0 = time.monotonic()
    entry_data = _find_entry_data(hass, msg["device_id"])
    if entry_data is None:
        connection.send_error(
            msg["id"], "not_found", "Doorbell not configured on this Home Assistant instance"
        )
        return

    session = async_get_clientsession(hass)
    try:
        creds = await api.async_get_app_turn_credentials(
            session, entry_data[CONF_DEVICE_ID], entry_data[CONF_CREDENTIAL]
        )
    except api.AuthenticationError:
        connection.send_error(
            msg["id"],
            "unauthorized",
            "Pairing credential is invalid or has been revoked - re-pair the doorbell from "
            "Settings > Devices & services",
        )
    except api.DoorbellApiError as err:
        _LOGGER.warning("Failed requesting TURN credentials for %s: %s", msg["device_id"], err)
        connection.send_error(msg["id"], "cloud_error", str(err))
    else:
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        _LOGGER.debug(
            "[islautopia_doorbell timing] get_turn_credentials for %s: %sms",
            msg["device_id"],
            elapsed_ms,
        )
        connection.send_result(msg["id"], creds)
