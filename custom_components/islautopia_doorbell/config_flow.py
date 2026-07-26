"""Config flow for the Islautopia Doorbell integration.

Two ways in:
  - Zeroconf discovery (`_igdoorbell._tcp.local.`, the same service the app/dashboard already
    use - API_CONTRACT.md §0-bis): automatic, shows up as a "Discovered" card in HA.
  - Manual entry (host/IP): fallback for networks without mDNS, or first-contact troubleshooting.

Either way, pairing itself is identical and happens exactly once: ask for the admin
email/password already created via the doorbell's own /api/setup, use them only long enough to
call async_login + async_pair_app, then discard them - only the resulting 64-hex pair_app
credential is persisted (in the config entry's own data, via HA's normal config-entry storage).
See ARCHITECTURE.md §3/§4.2 for why nothing else is kept.
"""
from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from . import api
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_HOST_HINT,
    CONF_LABEL,
    DEFAULT_PAIR_LABEL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


async def _async_pair(
    device_id: str, email: str, password: str
) -> tuple[api.PairResult | None, str | None]:
    """Run the one-shot login+pair_app+logout sequence in a private, throwaway session.

    Returns (result, error_code). Never reuses HA's shared aiohttp session for this - the
    session cookie from /api/login must not leak anywhere else, and the session is closed
    (dropping the cookie) as soon as pairing finishes either way.
    """
    session = aiohttp.ClientSession()
    try:
        await api.async_login(session, device_id, email, password)
        result = await api.async_pair_app(session, device_id, DEFAULT_PAIR_LABEL)
    except api.AuthenticationError:
        return None, "invalid_auth"
    except api.DeviceNotPairedError:
        return None, "device_not_paired"
    except api.CloudAuthorizeFailedError:
        return None, "cloud_authorize_failed"
    except aiohttp.ClientError:
        return None, "cannot_connect"
    else:
        await api.async_logout(session, device_id)
        return result, None
    finally:
        if not session.closed:
            await session.close()


class IslautopiaDoorbellConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for a single Islautopia Doorbell."""

    VERSION = 1

    def __init__(self) -> None:
        self._device_id: str | None = None
        self._host_hint: str | None = None
        self._name_hint: str | None = None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Manual entry: ask for the doorbell's local IP/hostname."""
        errors: dict[str, str] = {}
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            session = async_get_clientsession(self.hass)
            try:
                device_id = await api.async_get_device_id(session, host)
            except aiohttp.ClientError:
                errors["base"] = "cannot_connect"
            except api.DoorbellApiError:
                errors["base"] = "not_a_doorbell"
            else:
                await self.async_set_unique_id(device_id)
                self._abort_if_unique_id_configured()
                self._device_id = device_id
                self._host_hint = host
                return await self.async_step_pair()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_HOST): str}),
            errors=errors,
        )

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> FlowResult:
        """Handle discovery via `_igdoorbell._tcp.local.`.

        Match by the `device_id` TXT record, never by the mDNS instance name - see the module
        docstring and COORDINATION.md Q6.
        """
        device_id = discovery_info.properties.get("device_id")
        if not device_id:
            return self.async_abort(reason="no_device_id")

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured(updates={CONF_HOST_HINT: discovery_info.host})

        self._device_id = device_id
        self._host_hint = discovery_info.host
        self._name_hint = discovery_info.properties.get("name") or device_id

        self.context["title_placeholders"] = {"name": self._name_hint}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            return await self.async_step_pair()
        return self.async_show_form(
            step_id="zeroconf_confirm",
            description_placeholders={"name": self._name_hint or self._device_id or ""},
        )

    async def async_step_pair(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Log in once, call pair_app once, keep only the resulting credential."""
        errors: dict[str, str] = {}
        if user_input is not None:
            assert self._device_id is not None
            result, error = await _async_pair(
                self._device_id, user_input["email"], user_input["password"]
            )
            if error:
                errors["base"] = error
            else:
                assert result is not None
                return self.async_create_entry(
                    title=self._name_hint or result.device_id,
                    data={
                        CONF_DEVICE_ID: result.device_id,
                        CONF_CREDENTIAL: result.credential,
                        CONF_HOST_HINT: self._host_hint,
                        CONF_LABEL: DEFAULT_PAIR_LABEL,
                    },
                )

        return self.async_show_form(
            step_id="pair",
            data_schema=vol.Schema({vol.Required("email"): str, vol.Required("password"): str}),
            errors=errors,
            description_placeholders={"name": self._name_hint or self._device_id or ""},
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> "IslautopiaDoorbellOptionsFlow":
        return IslautopiaDoorbellOptionsFlow(config_entry)


class IslautopiaDoorbellOptionsFlow(config_entries.OptionsFlow):
    """Re-pair - e.g. after the credential was revoked from the cloud admin panel."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            device_id = self._entry.data[CONF_DEVICE_ID]
            result, error = await _async_pair(
                device_id, user_input["email"], user_input["password"]
            )
            if error:
                errors["base"] = error
            else:
                assert result is not None
                new_data = dict(self._entry.data)
                new_data[CONF_CREDENTIAL] = result.credential
                self.hass.config_entries.async_update_entry(self._entry, data=new_data)
                return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({vol.Required("email"): str, vol.Required("password"): str}),
            errors=errors,
        )
