"""Actions: play a quick reply or a sequence at the street, over the signalling channel.

Same messages as the apps (signal_client.py), so no firmware route was added for Home Assistant.
Failures are raised, never swallowed: someone may be waiting at the door, and an action that
"succeeds" without playing anything is the silent no-op this project refuses.
"""
from __future__ import annotations

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from . import api, signal_client
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN

ATTR_DEVICE = "device_id"

_SCHEMA_SEQ = vol.Schema({
    vol.Required(ATTR_DEVICE): cv.string,
    vol.Required("seq_id"): vol.All(vol.Coerce(int), vol.Range(min=0)),
})
_SCHEMA_AUDIO = vol.Schema({
    vol.Required(ATTR_DEVICE): cv.string,
    vol.Required("audio_slot"): vol.All(vol.Coerce(int), vol.Range(min=1, max=10)),
})

# What the doorbell's refusals mean to the person who ran the action (§3.3-bis, §3.3).
_ERRORS = {
    "not_found": "That sequence does not exist on the doorbell.",
    "empty_slot": "That quick-reply slot has no audio.",
    "bad_slot": "Quick-reply slot out of range (1-10).",
    "busy": "The doorbell is already playing something.",
    "admin_required": "This pairing is not an administrator of the doorbell.",
}


def _entry_data_for(hass: HomeAssistant, ha_device_id: str) -> dict:
    """Entry data for an HA device id (the device selector's value) or our own device id."""
    ours = ha_device_id
    device = dr.async_get(hass).async_get(ha_device_id)
    if device is not None:
        ours = next((i[1] for i in device.identifiers if i[0] == DOMAIN), ha_device_id)
    stored = hass.data.get(DOMAIN, {})
    for entry in hass.config_entries.async_entries(DOMAIN):
        d = stored.get(entry.entry_id)
        if isinstance(d, dict) and d.get(CONF_DEVICE_ID) == ours and "session" in d:
            return d
    raise ServiceValidationError(f"No IG Doorbell set up for device {ha_device_id}")


async def _run_command(hass: HomeAssistant, call: ServiceCall, message: dict, response_type: str) -> None:
    d = _entry_data_for(hass, call.data[ATTR_DEVICE])
    try:
        r = await signal_client.async_send_command(
            d["session"], d[CONF_DEVICE_ID], d[CONF_CREDENTIAL], message, response_type
        )
    except api.DoorbellApiError as err:
        raise HomeAssistantError(f"The doorbell did not take the command: {err}") from err
    if r.get("error"):
        raise HomeAssistantError(_ERRORS.get(r["error"], f"The doorbell refused: {r['error']}"))


@callback
def async_register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, "play_sequence"):
        return

    async def play_sequence(call: ServiceCall) -> None:
        await _run_command(hass, call, {"type": "play_sequence", "seq_id": call.data["seq_id"]},
                     "play_sequence_result")

    async def play_audio(call: ServiceCall) -> None:
        await _run_command(hass, call, {"type": "play_audio", "audio_slot": call.data["audio_slot"]},
                     "play_audio_result")

    hass.services.async_register(DOMAIN, "play_sequence", play_sequence, schema=_SCHEMA_SEQ)
    hass.services.async_register(DOMAIN, "play_audio", play_audio, schema=_SCHEMA_AUDIO)
