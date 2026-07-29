"""The Islautopia Doorbell integration.

Three runtime responsibilities, deliberately kept this small - see ARCHITECTURE.md §3 for the
reasoning behind what this integration does NOT do (no polling of the doorbell's local REST API,
no persisted admin session, no media proxying):

  1. Dispatch `videoportero/door/action` MQTT messages to the right HA service - mqtt_dispatch.py.
     This is the actual point of the integration; see that module's docstring.
  2. Credential broker for the Lovelace card (pairing done once in config_flow.py, TURN
     credentials served on demand) - websocket_api.py.
  3. Config flow itself (Zeroconf discovery + manual entry, no YAML) - config_flow.py.

No entity platforms are set up here on purpose: the state a user would want in HA (mode,
doorbell/presence sensors, an "open door" button) is already published by the firmware's own
MQTT discovery (`main/networktask.c::enviar_ha_discovery_completo()` in IG_Doorbell) the moment
the user points the doorbell at a broker - this integration doesn't need to duplicate it.

IMPORTANT (found via real-hardware testing 2026-07-09): the device this
integration registers MUST share identifiers with the device the firmware's own MQTT discovery
creates, or the user ends up with two separate, disconnected devices in HA - ours with zero
entities (confusing, looks broken) and a second "IG-Doorbell" one (created by the `mqtt`
integration) holding the actual mode / doorbell / door / presence / open-door entities. See
`async_setup_entry` below for the fix (matching identifier so HA's device registry merges them
into a single device).
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from .const import CONF_DEVICE_ID, DOMAIN
from .mqtt_dispatch import async_ensure_door_action_listener, async_release_door_action_listener
from .signal_proxy import async_register_signal_proxy
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

# No entity platforms today - see module docstring above.
PLATFORMS: list[str] = []


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register integration-wide resources once, regardless of how many entries get added."""
    async_register_websocket_commands(hass)
    async_register_signal_proxy(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one paired doorbell."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = dict(entry.data)

    # Register a device purely so this doorbell shows up in HA's own device registry - no
    # entity platforms are attached to it (see module docstring), but the Lovelace card's
    # editor uses the native `ha-selector` device picker (filtered to this integration) to let
    # the user pick a doorbell without ever typing/copying a device_id by hand. That picker
    # only lists devices that actually exist in the registry - hence this call.
    #
    # TWO identifiers on purpose (fix for the "device has no entities" bug found in real
    # testing): our own (DOMAIN, device_id) - required by the card editor's device picker
    # lookup, which specifically searches for this exact pair in `device.identifiers` (see
    # islautopia-intercom-card's findOurDeviceIdForHaDeviceId/findHaDeviceIdForOurDeviceId) -
    # AND the SAME identifier the firmware's own MQTT discovery uses for its device block
    # (`main/networktask.c`: `"dev":{"ids":["ig_doorbell_<dev_id>"], ...}` - MQTT discovery
    # registers that as identifier ("mqtt", "ig_doorbell_<dev_id>") in HA's device registry).
    # Registering both on the SAME device_registry entry makes Home Assistant MERGE this
    # integration's device with the one MQTT discovery already created (or will create) for the
    # exact same physical doorbell - one single device in the UI, holding both the MQTT-published
    # entities (mode / doorbell / door / presence / open-door) and this integration's own config
    # entry, instead of two disconnected devices where ours looked broken with zero entities.
    # Order doesn't matter - HA's device registry merges on identifier match regardless of which
    # integration registers first.
    # Deliberately do NOT pass `name=` here (found via real-hardware testing 2026-07-09):
    # the firmware itself is the only real source of truth for the device's
    # user-configured `device_name` (§0-bis of API_CONTRACT.md) - it now ships that name inside
    # its own MQTT discovery `dev.name` field (added to the firmware the same day).
    # `async_get_or_create`
    # only overwrites the stored device name when `name` is explicitly passed - passing
    # `name=entry.title` here on EVERY setup/reload would race against the mqtt integration's own
    # registration call for the same merged device (see identifiers below) and could stomp the
    # real device_name back to our own entry.title (a Zeroconf mDNS name hint, or the raw
    # device_id in the manual-entry case - see config_flow.py) depending on which integration's
    # call happened to run last. Omitting `name` here means: HA still gives the device a sane
    # initial name (device_registry falls back to this config entry's own title automatically
    # for a brand-new device that has no name yet), but once MQTT discovery registers its own
    # explicit `name` for the merged device, our reloads/restarts never overwrite it again.
    mqtt_ident = f"ig_doorbell_{entry.data[CONF_DEVICE_ID]}"
    device_registry = dr.async_get(hass)
    device = device_registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={
            (DOMAIN, entry.data[CONF_DEVICE_ID]),
            ("mqtt", mqtt_ident),
        },
        manufacturer="Islautopia",
        model="IG Doorbell",
    )

    # Real instrumentation (2026-07-10 - the "no entities" bug reappeared after the mDNS batch
    # was deployed, with this very identifier-merging fix already present in the code). The first
    # attempt at this log line (using logging's deferred %s/%r formatting) vanished without a
    # trace: nothing in home-assistant.log, no visible exception. Real finding: the code AFTER
    # this block (async_ensure_door_action_listener) kept running normally, which rules out an
    # exception while evaluating the arguments (that would have aborted the whole function). The
    # most likely suspect is that logging's own lazy formatting (record.getMessage(), which only
    # runs on emit, not on call) blew up on something inside device.identifiers /
    # device.config_entries, and that Handler.handleError() swallowed it by sending it to stderr
    # instead of to the log file - so this time the whole message is built as plain text BEFORE
    # calling _LOGGER.debug(), with explicit error handling so a failure here can never be
    # invisible again (if anything inside this block breaks, at least that error itself shows up).
    try:
        diag_msg = (
            "[islautopia_doorbell diag] device after async_get_or_create: "
            f"id={device.id!r} name={device.name!r} name_by_user={device.name_by_user!r} "
            f"identifiers={sorted(str(i) for i in device.identifiers)} "
            f"config_entries={sorted(str(c) for c in device.config_entries)} "
            f"(we were looking for identifiers={sorted(str(i) for i in {(DOMAIN, entry.data[CONF_DEVICE_ID]), ('mqtt', mqtt_ident)})})"
        )
    except Exception as diag_err:  # noqa: BLE001 - deliberate, see the comment above
        _LOGGER.debug(
            "[islautopia_doorbell diag] failed to build the diagnostic message: %r", diag_err
        )
    else:
        _LOGGER.debug(diag_msg)

    # Reference-counted: the MQTT listener for videoportero/door/action is global (the topic
    # itself carries no device_id) - only one subscription is ever
    # active, kept alive as long as at least one entry is loaded.
    await async_ensure_door_action_listener(hass)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    await async_release_door_action_listener(hass)
    hass.data[DOMAIN].pop(entry.entry_id, None)
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload the entry when its data changes (e.g. after a re-pair via the options flow)."""
    hass.data[DOMAIN][entry.entry_id] = dict(entry.data)
