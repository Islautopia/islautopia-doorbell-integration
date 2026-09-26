"""Phase 0 rule 2: setup fails clearly without direct IP, and nothing is configured half-way."""
from __future__ import annotations

import socket
from unittest.mock import AsyncMock, patch

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.ig_doorbell import api, config_flow
from custom_components.ig_doorbell.const import CONF_HOST_HINT, DOMAIN

from .conftest import CREDENTIAL, DEVICE_ID, LAN_IP


async def _inicio(hass):
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )


async def test_unreachable_ip_says_same_network_and_creates_nothing(hass):
    r = await _inicio(hass)
    with patch.object(api, "async_get_device_id", AsyncMock(side_effect=OSError("no route"))):
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"host": LAN_IP})
    assert r["type"] is FlowResultType.FORM
    assert r["errors"] == {"base": "not_on_lan"}
    assert hass.config_entries.async_entries(DOMAIN) == []


async def test_cloud_hostname_is_refused_without_resolving_it(hass):
    """Typing the doorbell's cloud name must not send a DNS query for it."""
    llamadas = []

    def _chivato(*a, **k):
        llamadas.append(a)
        raise AssertionError("DNS")

    r = await _inicio(hass)
    with patch.object(socket, "getaddrinfo", _chivato):
        r = await hass.config_entries.flow.async_configure(
            r["flow_id"], {"host": f"{DEVICE_ID}.doorbell.islautopia.com"}
        )
    assert r["errors"] == {"base": "not_on_lan"}
    assert llamadas == []


async def test_port_80_ok_but_no_tls_is_an_error_too(hass):
    r = await _inicio(hass)
    with patch.object(api, "async_get_device_id", AsyncMock(return_value=DEVICE_ID)), \
         patch.object(api, "async_check_tls", AsyncMock(side_effect=api.DoorbellApiError("tls"))):
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"host": LAN_IP})
    assert r["errors"] == {"base": "no_tls"}
    assert hass.config_entries.async_entries(DOMAIN) == []


async def _hasta_pair(hass):
    r = await _inicio(hass)
    with patch.object(api, "async_get_device_id", AsyncMock(return_value=DEVICE_ID)), \
         patch.object(api, "async_check_tls", AsyncMock()):
        r = await hass.config_entries.flow.async_configure(r["flow_id"], {"host": LAN_IP})
    assert r["step_id"] == "pair"
    return r


async def test_a_pairing_that_does_not_work_is_undone_on_the_doorbell(hass):
    r = await _hasta_pair(hass)
    unpair = AsyncMock(return_value=True)
    with patch.object(api, "async_login", AsyncMock()), \
         patch.object(api, "async_pair_app", AsyncMock(return_value=api.PairResult(DEVICE_ID, CREDENTIAL))), \
         patch.object(api, "async_get_states", AsyncMock(side_effect=api.DoorbellApiError("x"))), \
         patch.object(api, "async_unpair_app", unpair), \
         patch.object(api, "async_logout", AsyncMock()):
        r = await hass.config_entries.flow.async_configure(
            r["flow_id"], {"email": "a@b.c", "password": "p"}
        )
    assert r["errors"] == {"base": "pair_verify_failed"}
    unpair.assert_awaited_once()
    assert hass.config_entries.async_entries(DOMAIN) == []


async def test_happy_path_stores_the_ip_and_the_credential(hass):
    r = await _hasta_pair(hass)
    with patch.object(api, "async_login", AsyncMock()), \
         patch.object(api, "async_pair_app", AsyncMock(return_value=api.PairResult(DEVICE_ID, CREDENTIAL))), \
         patch.object(api, "async_get_states", AsyncMock(return_value={})), \
         patch.object(api, "async_unpair_app", AsyncMock()) as unpair, \
         patch.object(api, "async_logout", AsyncMock()), \
         patch("custom_components.ig_doorbell.async_setup_entry", AsyncMock(return_value=True)):
        r = await hass.config_entries.flow.async_configure(
            r["flow_id"], {"email": "a@b.c", "password": "p"}
        )
    assert r["type"] is FlowResultType.CREATE_ENTRY
    assert r["data"][CONF_HOST_HINT] == LAN_IP
    # A new entry gets a label of its own: a second HA of the same admin must not take over the
    # first one's slot (§1.5 reuses the slot on the same email|label).
    assert r["data"]["label"].startswith("Home Assistant ") and r["data"]["label"] != "Home Assistant"
    unpair.assert_not_awaited()


async def test_pairing_session_maps_only_the_doorbell_name_to_the_lan_ip(hass):
    """The session used for login/pair_app is the LAN-only one, mapped to the flow's IP."""
    vistos = {}
    real = config_flow.net.crear_sesion

    def _espia(h, mapeo):
        vistos.update(mapeo)
        return real(h, mapeo)

    with patch.object(config_flow.net, "crear_sesion", _espia), \
         patch.object(api, "async_login", AsyncMock(side_effect=api.AuthenticationError())):
        res, err = await config_flow._async_pair(hass, DEVICE_ID, LAN_IP, "a", "b", "Home Assistant X")
    assert err == "invalid_auth"
    assert vistos == {f"{DEVICE_ID}.doorbell.islautopia.com": LAN_IP}


async def test_undo_goes_by_slot_because_labels_with_spaces_404():
    """Measured on 0.100.0: unpair_app by a label with a space answers 404. Undo must use the slot."""
    enviados = []

    class _R:
        def __init__(self, status, datos=None):
            self.status, self._d = status, datos

        async def json(self, content_type=None):
            return self._d

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class _S:
        def get(self, url, **kw):
            return _R(200, {"apps": [{"slot": 2, "label": "iPhone"}, {"slot": 5, "label": "Home Assistant Casa"}]})

        def post(self, url, data=None, **kw):
            enviados.append((url.rsplit("/", 1)[-1], data))
            return _R(200)

    assert await api.async_unpair_app(_S(), DEVICE_ID, "Home Assistant Casa")
    assert enviados == [("unpair_app", {"slot": "5"})]
