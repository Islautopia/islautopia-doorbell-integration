"""Config flow for the Islautopia Doorbell integration.

Two ways in:
  - Zeroconf discovery (`_igdoorbell._tcp.local.`, the same service the app/dashboard already
    use - API_CONTRACT.md §0-bis): automatic, shows up as a "Discovered" card in HA.
  - Manual entry (IP): for networks without mDNS, or a doorbell on another (routed) VLAN.

## LAN only, and nothing half-configured (Phase 0, 2026-09-25)

Home Assistant is a LOCAL client: it reaches the doorbell at its LAN address and never through the
VPS or public DNS (net.py). So setup first checks that the doorbell answers **at that address** on
port 80 (`/api/device_id`) **and** on 8443 with a certificate valid for its name. If either fails,
setup stops with one message — Home Assistant must be on the same network as the doorbell — and
creates nothing. If pairing succeeds but the new credential then fails to work over the LAN, the
pairing is undone on the doorbell (`unpair_app`) before reporting the error.

Pairing itself happens exactly once: ask for the admin email/password already created via the
doorbell's own /api/setup, use them only long enough to call login + pair_app, then discard them -
only the resulting 64-hex pair_app credential is persisted (in the config entry's data).
"""
from __future__ import annotations

import asyncio
import logging
import socket
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant import config_entries
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from . import api, net
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_ENTIDADES,
    CONF_HOST_HINT,
    CONF_LABEL,
    DEFAULT_PAIR_LABEL,
    DOMAIN,
    DOMAIN_OPEN_SERVICE,
    DOORBELL_HOSTNAME_SUFFIX,
    MAX_ENTIDADES,
)

_LOGGER = logging.getLogger(__name__)


async def _direccion_de(host: str) -> str | None:
    """A literal IP for what the user typed.

    A LOCAL name goes through the home's resolver once and the address is what gets stored. Our
    cloud's name is refused: resolving it is asking the VPS where the doorbell is.
    """
    host = (host or "").strip()
    if net.es_direccion(host):
        return host
    if not host or host.lower().rstrip(".").endswith(DOORBELL_HOSTNAME_SUFFIX):
        return None
    try:
        info = await asyncio.get_running_loop().getaddrinfo(
            host, 80, family=socket.AF_INET, type=socket.SOCK_STREAM
        )
    except OSError:
        return None
    return info[0][4][0] if info else None


async def _comprobar_lan(
    hass: HomeAssistant, ip: str, device_id: str | None = None
) -> tuple[str | None, str | None]:
    """Is THIS doorbell reachable directly at `ip`, on both ports? Returns (device_id, error_key).

    Port 80 `/api/device_id` says which doorbell it is; 8443 must then answer with a certificate
    valid for that doorbell's name, through the LAN mapping only (net.py). Nothing is written.
    """
    sesion = net.crear_sesion(hass, {})
    try:
        encontrado = await asyncio.wait_for(api.async_get_device_id(sesion, ip), 6)
    except (aiohttp.ClientError, OSError, TimeoutError, api.DoorbellApiError):
        return None, "not_on_lan"
    finally:
        await sesion.close()
    if device_id is not None and encontrado != device_id:
        return None, "other_device"
    sesion = net.crear_sesion(hass, {api.doorbell_hostname(encontrado): ip})
    try:
        await api.async_check_tls(sesion, encontrado)
    except api.DoorbellApiError:
        return encontrado, "no_tls"
    finally:
        await sesion.close()
    return encontrado, None


def _etiqueta_nueva(hass: HomeAssistant) -> str:
    """The pairing label for a NEW entry: "Home Assistant <location name>".

    ⚠️ Not the bare "Home Assistant" any more (0.7.0). The doorbell identifies a pairing by
    `email|label` and REUSES the slot when both repeat (§1.5): a second Home Assistant in the same
    house, paired by the same admin, silently took over the first one's credential, and the first
    one started getting 401 with nothing explaining why. Existing entries keep their stored label
    (re-pairing must reuse their slot, not open a new one).
    """
    nombre = (getattr(hass.config, "location_name", "") or "").strip()
    return f"{DEFAULT_PAIR_LABEL} {nombre}".strip()[:32]


async def _async_pair(
    hass: HomeAssistant, device_id: str, ip: str, email: str, password: str, label: str
) -> tuple[api.PairResult | None, str | None]:
    """login + pair_app + verify + logout, in a private, throwaway LAN session.

    Returns (result, error_code). The session cookie from /api/login never leaves this function.

    ⚠️ NOTHING HALF-CONFIGURED: if pair_app succeeded but the new credential does not work over
    the LAN (get_states), the pairing is undone with unpair_app — still inside the admin session —
    before the error is reported. Otherwise a failed setup would leave a live credential on the
    doorbell that no Home Assistant entry knows about, eating one of its pairing slots.
    """
    if not net.es_direccion(ip):
        return None, "not_on_lan"
    session = net.crear_sesion(hass, {api.doorbell_hostname(device_id): ip})
    try:
        await api.async_login(session, device_id, email, password)
        result = await api.async_pair_app(session, device_id, label)
        try:
            await api.async_get_states(session, device_id, result.credential)
        except api.DoorbellApiError:
            deshecho = await api.async_unpair_app(session, device_id, label)
            _LOGGER.warning(
                "Pairing with %s succeeded but the credential does not work over the LAN; "
                "pairing undone on the doorbell: %s", device_id, deshecho,
            )
            return None, "pair_verify_failed"
    except api.AuthenticationError:
        return None, "invalid_auth"
    except api.LabelInUseError:
        return None, "label_in_use"
    except api.DeviceNotPairedError:
        return None, "device_not_paired"
    except api.CloudAuthorizeFailedError:
        return None, "cloud_authorize_failed"
    except (aiohttp.ClientError, OSError, TimeoutError, api.DoorbellApiError):
        return None, "not_on_lan"
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
        """Manual entry: the doorbell's LAN IP."""
        errors: dict[str, str] = {}
        host = ""
        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            ip = await _direccion_de(host)
            if ip is None:
                errors["base"] = "not_on_lan"
            else:
                device_id, error = await _comprobar_lan(self.hass, ip)
                if error:
                    errors["base"] = error
                else:
                    await self.async_set_unique_id(device_id)
                    self._abort_if_unique_id_configured(updates={CONF_HOST_HINT: ip})
                    self._device_id = device_id
                    self._host_hint = ip
                    return await self.async_step_pair()

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_HOST, default=host): str}),
            errors=errors,
            description_placeholders={"host": host},
        )

    async def async_step_zeroconf(self, discovery_info: ZeroconfServiceInfo) -> FlowResult:
        """Handle discovery via `_igdoorbell._tcp.local.`.

        Match by the `device_id` TXT record, never by the mDNS instance name. For an existing entry
        this is also how a doorbell that DHCP moved is found again: the new address is stored and
        the entry reloads (there is no cloud-DNS fallback any more, net.py).
        """
        device_id = discovery_info.properties.get("device_id")
        if not device_id:
            return self.async_abort(reason="no_device_id")

        await self.async_set_unique_id(device_id)
        self._abort_if_unique_id_configured(updates={CONF_HOST_HINT: discovery_info.host})

        _, error = await _comprobar_lan(self.hass, discovery_info.host, device_id)
        if error:
            return self.async_abort(
                reason=error, description_placeholders={"host": discovery_info.host}
            )

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
            label = _etiqueta_nueva(self.hass)
            result, error = await _async_pair(
                self.hass, self._device_id, self._host_hint or "",
                user_input["email"], user_input["password"], label,
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
                        CONF_LABEL: label,
                    },
                )

        return self.async_show_form(
            step_id="pair",
            data_schema=vol.Schema({vol.Required("email"): str, vol.Required("password"): str}),
            errors=errors,
            description_placeholders={
                "name": self._name_hint or self._device_id or "",
                "host": self._host_hint or "",
            },
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> "IslautopiaDoorbellOptionsFlow":
        return IslautopiaDoorbellOptionsFlow(config_entry)


class IslautopiaDoorbellOptionsFlow(config_entries.OptionsFlow):
    """Entities the doorbell may act on, the doorbell's LAN address, and re-pairing."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        return self.async_show_menu(
            step_id="init", menu_options=["entidades", "direccion", "reemparejar"]
        )

    async def async_step_entidades(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Que entidades de Home Assistant puede accionar el portero (contrato §4).

        Se eligen AQUI, en Home Assistant, y viajan al portero. El desplegable que ve el usuario en
        la app lo lee **del portero**, no de Home Assistant. Por eso viaja tambien el nombre
        visible de cada una: `light.porche_2` no le dice nada a nadie.

        ⚠️ Y por eso NO viajan dominios enteros: una casa normal tiene cientos de `light.*`.
        """
        errors: dict[str, str] = {}
        if user_input is not None:
            elegidas = user_input.get(CONF_ENTIDADES) or []
            if len(elegidas) > MAX_ENTIDADES:
                # Se rechaza y se dice, nunca se recorta en silencio.
                errors["base"] = "demasiadas"
            else:
                # ⚠️ Se conservan las demas opciones: un flujo de opciones REEMPLAZA el diccionario
                # entero, asi que devolver solo lo de este paso borraria lo demas en silencio.
                opciones = dict(self._entry.options)
                opciones[CONF_ENTIDADES] = elegidas
                return self.async_create_entry(title="", data=opciones)

        actuales = self._entry.options.get(CONF_ENTIDADES) or []
        return self.async_show_form(
            step_id="entidades",
            data_schema=vol.Schema(
                {
                    vol.Optional(CONF_ENTIDADES, default=actuales): selector.EntitySelector(
                        selector.EntitySelectorConfig(
                            # Solo los dominios que el portero sabe accionar de verdad
                            # (DOMAIN_OPEN_SERVICE en const.py).
                            domain=sorted(DOMAIN_OPEN_SERVICE),
                            multiple=True,
                        )
                    )
                }
            ),
            errors=errors,
            description_placeholders={"max": str(MAX_ENTIDADES)},
        )

    async def async_step_direccion(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Change the doorbell's LAN address (DHCP moved it, or it changed VLAN).

        There is no cloud-DNS fallback any more (net.py), so this and zeroconf are how a moved
        doorbell is found again. The new address must answer as THIS doorbell on both ports.
        """
        errors: dict[str, str] = {}
        actual = self._entry.data.get(CONF_HOST_HINT) or ""
        pedido = actual
        if user_input is not None:
            pedido = user_input[CONF_HOST].strip()
            ip = await _direccion_de(pedido)
            if ip is None:
                errors["base"] = "not_on_lan"
            else:
                _, error = await _comprobar_lan(self.hass, ip, self._entry.data[CONF_DEVICE_ID])
                if error:
                    errors["base"] = error
                else:
                    self.hass.config_entries.async_update_entry(
                        self._entry, data={**self._entry.data, CONF_HOST_HINT: ip}
                    )
                    return self.async_create_entry(title="", data=dict(self._entry.options))
        return self.async_show_form(
            step_id="direccion",
            data_schema=vol.Schema({vol.Required(CONF_HOST, default=pedido): str}),
            errors=errors,
            description_placeholders={"host": pedido},
        )

    async def async_step_reemparejar(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Reemparejar - p.ej. tras revocar la credencial desde el panel de la nube."""
        errors: dict[str, str] = {}
        if user_input is not None:
            device_id = self._entry.data[CONF_DEVICE_ID]
            result, error = await _async_pair(
                self.hass, device_id, self._entry.data.get(CONF_HOST_HINT) or "",
                user_input["email"], user_input["password"],
                self._entry.data.get(CONF_LABEL) or DEFAULT_PAIR_LABEL,
            )
            if error:
                errors["base"] = error
            else:
                assert result is not None
                new_data = dict(self._entry.data)
                new_data[CONF_CREDENTIAL] = result.credential
                self.hass.config_entries.async_update_entry(self._entry, data=new_data)
                # ⚠️ `data=dict(self._entry.options)` y NO `data={}`: un flujo de opciones
                # REEMPLAZA el diccionario entero y se llevaria la lista de entidades.
                return self.async_create_entry(title="", data=dict(self._entry.options))

        return self.async_show_form(
            step_id="reemparejar",
            data_schema=vol.Schema({vol.Required("email"): str, vol.Required("password"): str}),
            errors=errors,
            description_placeholders={"host": self._entry.data.get(CONF_HOST_HINT) or ""},
        )
