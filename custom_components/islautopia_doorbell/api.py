"""Thin async HTTP client for the doorbell's own API, over the LAN only.

Every function here takes the per-entry session built by net.crear_sesion(), whose resolver maps
the doorbell's certificate name to its stored LAN address and to nothing else (no DNS, no relay —
Phase 0 of the parity plan, 2026-09-25). The URLs carry `<device_id>.doorbell.islautopia.com`
only so that TLS validates against the name the certificate is issued for.

⚠️ The pairing credential NEVER leaves Home Assistant's server side. Nothing in this module builds a
URL that is handed to a browser; recordings reach the browser through recordings_view.py, which
adds the credential server-side.

See API_CONTRACT.md (IG_Doorbell repo): §0 (device_id), §1.1 (login), §1.5 (pair_app/unpair_app),
§1.2 (get_states/save_states/open), §1.3-bis (recordings), §4 (hass).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from urllib.parse import quote

import aiohttp

from .const import DOORBELL_HOSTNAME_SUFFIX, REQUEST_TIMEOUT

_LOGGER = logging.getLogger(__name__)

_TIMEOUT = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)


class DoorbellApiError(Exception):
    """Base error talking to a doorbell."""


class AuthenticationError(DoorbellApiError):
    """Wrong email/password, or the pairing credential was rejected."""


class DeviceNotPairedError(DoorbellApiError):
    """The doorbell itself is not registered with the cloud yet (409 device_not_paired)."""


class LabelInUseError(DoorbellApiError):
    """409 label_already_used: another user of this doorbell already has a client with that name."""


class CloudAuthorizeFailedError(DoorbellApiError):
    """The cloud rejected registering the new app instance (502 cloud_authorize_failed)."""


@dataclass
class PairResult:
    device_id: str
    credential: str


def doorbell_hostname(device_id: str) -> str:
    """The name the doorbell's certificate is issued for. Used for TLS only, never resolved."""
    return f"{device_id}.{DOORBELL_HOSTNAME_SUFFIX}"


async def async_get_device_id(session: aiohttp.ClientSession, host_or_ip: str) -> str:
    """GET /api/device_id (plain HTTP, port 80, no session needed) - first contact only.

    Deliberately the ONLY call in this module against a raw IP/host instead of the real
    `<device_id>.doorbell.islautopia.com` hostname - API_CONTRACT.md §0 documents this route as
    existing exactly for this: safe, read-only, no credentials involved. Never call
    async_login/async_pair_app against a raw IP - both of those always target the real
    hostname on purpose (see the contract's explicit warning against relaxing TLS hostname
    verification for anything sensitive).
    """
    url = f"http://{host_or_ip}/api/device_id"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                raise DoorbellApiError(f"GET /api/device_id -> HTTP {resp.status}")
            data = await resp.json(content_type=None)
    except aiohttp.ContentTypeError as err:
        raise DoorbellApiError("Response from /api/device_id is not valid JSON") from err
    device_id = data.get("device_id") if isinstance(data, dict) else None
    if not device_id:
        raise DoorbellApiError("Response from /api/device_id has no 'device_id'")
    return device_id


async def async_login(
    session: aiohttp.ClientSession, device_id: str, email: str, password: str
) -> None:
    """POST /api/login against the real hostname (HTTPS 8443) - sets a cookie on `session`.

    Transitory by design: the caller (config_flow.py) uses this session only long enough to
    call async_pair_app, then discards it and never persists email/password to disk.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/api/login"
    async with session.post(
        url,
        data={"email": email, "password": password},
        timeout=_TIMEOUT,
        allow_redirects=False,
    ) as resp:
        # Contract §1.1: 302 to "/" on success, 302 to "/login?error=1" on failure - there is
        # no JSON error body to parse, only the status/Location tell success from failure.
        location = resp.headers.get("Location", "")
        if resp.status != 302 or "error=1" in location:
            raise AuthenticationError("Wrong administrator email or password")


async def async_pair_app(
    session: aiohttp.ClientSession, device_id: str, label: str
) -> PairResult:
    """POST /api/pair_app - requires the session cookie async_login just set on `session`."""
    url = f"https://{doorbell_hostname(device_id)}:8443/api/pair_app"
    async with session.post(url, data={"label": label}, timeout=_TIMEOUT) as resp:
        if resp.status == 409:
            cuerpo = await resp.json(content_type=None)
            if isinstance(cuerpo, dict) and cuerpo.get("error") == "label_already_used":
                raise LabelInUseError(cuerpo.get("label") or label)
            raise DeviceNotPairedError(
                "The doorbell is not paired with the cloud yet - wait for it to finish its own "
                "registration and try again"
            )
        if resp.status == 502:
            raise CloudAuthorizeFailedError(
                "The cloud rejected registering this app - try again later"
            )
        if resp.status != 200:
            raise DoorbellApiError(f"POST /api/pair_app -> HTTP {resp.status}")
        data = await resp.json(content_type=None)
    return PairResult(device_id=data["device_id"], credential=data["credential"])


async def async_logout(session: aiohttp.ClientSession, device_id: str) -> None:
    """POST /api/logout - best effort, frees one of the doorbell's 8 concurrent session slots."""
    url = f"https://{doorbell_hostname(device_id)}:8443/api/logout"
    try:
        async with session.post(url, timeout=_TIMEOUT):
            pass
    except aiohttp.ClientError:
        _LOGGER.debug("Best-effort logout failed for %s (non-blocking)", device_id)


async def async_unpair_app(session: aiohttp.ClientSession, device_id: str, label: str) -> bool:
    """Undo a pairing (§1.5) with the admin session cookie on `session`, found by its label.

    Used to undo a pairing when a later setup step fails, so a failed setup leaves nothing
    configured on the doorbell. Best effort: returns False instead of raising.

    ⚠️ By SLOT, looked up in `paired_apps`, and not `unpair_app?label=`: on firmware 0.100.0 an
    unpair by label that contains a space answers 404 whatever the encoding ('+' or '%20'),
    measured 2026-09-25 -- and every Home Assistant label has a space. The label route would have
    reported "not found" and left the pairing alive, which is exactly what this exists to prevent.
    """
    base = f"https://{doorbell_hostname(device_id)}:8443"
    try:
        async with session.get(f"{base}/api/paired_apps", timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                return False
            datos = await resp.json(content_type=None)
        apps = datos.get("apps", []) if isinstance(datos, dict) else []
        slots = [a.get("slot") for a in apps if isinstance(a, dict) and a.get("label") == label]
        if len(slots) != 1 or not isinstance(slots[0], int):
            return False
        async with session.post(
            f"{base}/api/unpair_app", data={"slot": str(slots[0])}, timeout=_TIMEOUT
        ) as resp:
            return resp.status == 200
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError):
        return False


async def async_check_tls(session: aiohttp.ClientSession, device_id: str) -> None:
    """GET https://<name>:8443/api/device_id through the LAN mapping, certificate validated.

    §0: this route exists on both ports, needs no session and has no side effect. Raises
    DoorbellApiError if the doorbell cannot be reached over TLS at its LAN address, or answers
    with another id.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/api/device_id"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status != 200:
                raise DoorbellApiError(f"GET :8443/api/device_id -> HTTP {resp.status}")
            data = await resp.json(content_type=None)
    except (aiohttp.ClientError, OSError, TimeoutError, ValueError) as err:
        raise DoorbellApiError(f"No TLS connection to the doorbell on the LAN: {err}") from err
    if not isinstance(data, dict) or data.get("device_id") != device_id:
        raise DoorbellApiError("Another device answered at that address")


def recording_url(device_id: str, credential: str, filename: str) -> str:
    """Doorbell URL of a recording's MP4. SERVER SIDE ONLY (recordings_view.py fetches it).

    ⚠️ Never hand this to a browser: it carries the pairing credential in the query string. Until
    0.6.x it was handed to the media player, which put the credential in every HA user's browser.
    """
    return (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/recording?file={quote(filename)}&token={quote(credential)}"
    )


def thumbnail_url(device_id: str, credential: str, filename: str) -> str:
    """Doorbell URL of a recording's thumbnail. SERVER SIDE ONLY, like recording_url()."""
    return (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/recording_thumb?file={quote(filename)}&token={quote(credential)}"
    )


async def async_list_recordings(
    session: aiohttp.ClientSession,
    device_id: str,
    credential: str,
    *,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """GET /api/list_recordings (contract §1.3-bis), authenticated with the pairing credential.

    Returns the firmware's own object as-is: {"total", "offset", "limit", "capped", "items"}.
    Deliberately not flattened to a bare list - `total` is what makes paging possible at all, and
    `capped` is the difference between "these are all your recordings" and "these are the 2000
    most recent of N", which a UI must not paper over.

    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/list_recordings?limit={limit}&offset={offset}&token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET list_recordings -> HTTP {resp.status}")
            return await resp.json(content_type=None)
    except aiohttp.ClientError as err:
        # Almost always "the doorbell is not reachable from this Home Assistant" - a different
        # VLAN, or simply powered off. Said plainly so it does not read as a credential problem.
        raise DoorbellApiError(f"Could not reach the doorbell to list recordings: {err}") from err


class NotAllowedError(DoorbellApiError):
    """The credential is valid but this role may not do that (403 admin_required).

    Distinct from AuthenticationError on purpose, and the firmware makes the same distinction for
    the same reason: a client needs to tell "I don't know who you are" from "I know who you are
    and you can't" - one means ask for credentials, the other means hide the button.
    """


async def async_check_recording_playable(
    session: aiohttp.ClientSession, device_id: str, credential: str, filename: str
) -> None:
    """Probe the recording so a failure surfaces as a sentence instead of a dead player.

    ⚠️ A one-byte ranged GET, not HEAD: the doorbell answers HEAD on /api/recording with 405
    (measured on 0.100.0, 2026-09-25), which made every recording "unplayable".

    Costs one LAN round trip and turns the commonest failure - a pairing made from a non-admin
    session, which may list and watch but not download - into something the user can act on.
    Returns None if playable; raises otherwise.
    """
    url = recording_url(device_id, credential, filename)
    try:
        async with session.get(url, headers={"Range": "bytes=0-0"}, timeout=_TIMEOUT) as resp:
            if resp.status == 403:
                raise NotAllowedError("admin_required")
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 404:
                raise DoorbellApiError("That recording no longer exists on the doorbell")
            if resp.status not in (200, 206):
                raise DoorbellApiError(f"GET recording -> HTTP {resp.status}")
    except aiohttp.ClientError as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


# ==================================================================================================
# ESTADO Y CONTROL -- lo que alimenta las entidades (2026-08-24)
#
# Estas cinco llamadas no existian porque hasta hoy `get_states`, `save_states` y `/open` solo
# aceptaban COOKIE DE SESION, y esta integracion guarda una credencial de `pair_app` y nunca la
# contrasena de administrador -- que es justo lo que el emparejamiento existe para evitar. Era la
# asimetria del hueco 9 del contrato, la misma que ya mordio con `firmware_info` y con las cuatro
# rutas del DVR. El firmware la cerro el 2026-08-24 y por eso esta integracion puede por fin tener
# entidades.
# ==================================================================================================


async def async_get_states(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> dict:
    """GET /api/get_states (contrato §1.2). Cookie **o** `?token=`, sin filtro de rol.

    Es todo el estado configurable del portero en una sola llamada, asi que es lo que alimenta a
    casi todas las entidades. Sin filtro de rol porque es de solo lectura y no devuelve ninguna
    contrasena -- `wifi_pass` no sale por ninguna ruta.
    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/get_states?token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET get_states -> HTTP {resp.status}")
            return await resp.json(content_type=None)
    except aiohttp.ClientError as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_get_firmware_info(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> dict:
    """GET /api/firmware_info (contrato §1.2-ter). Version, hardware, y el panel de calle si lo hay."""
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/firmware_info?token={quote(credential)}"
    )
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"GET firmware_info -> HTTP {resp.status}")
            return await resp.json(content_type=None)
    except aiohttp.ClientError as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_save_states(
    session: aiohttp.ClientSession, device_id: str, credential: str, campos: dict[str, str]
) -> None:
    """POST /api/save_states (contrato §1.2). **Exige rol admin.**

    Guardado PARCIAL: solo se escribe lo que va en el cuerpo, y omitir un campo lo deja intacto --
    nunca lo resetea. Por eso aqui se manda un diccionario y no el estado entero: mandar todo
    convertiria cualquier lectura desfasada en una escritura que pisa lo que otro acaba de cambiar.
    """
    url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/save_states?token={quote(credential)}"
    )
    try:
        async with session.post(url, data=campos, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError("This pairing is not an admin of that doorbell")
            if resp.status != 200:
                raise DoorbellApiError(f"POST save_states -> HTTP {resp.status}")
    except aiohttp.ClientError as err:
        raise DoorbellApiError(f"Could not reach the doorbell: {err}") from err


async def async_open_door(
    session: aiohttp.ClientSession, device_id: str, credential: str
) -> None:
    """GET /open (contrato §1.2). Cookie **o** `?token=`, **sin filtro de rol**.

    Sin rol a proposito: el mensaje `open` de la senalizacion nunca lo ha comprobado, asi que
    exigirlo aqui permitiria la misma accion por un camino y la negaria por el otro.

    `409 no_lock_configured` NO es un fallo de la peticion: es que ese portero no tiene cerradura
    (`door_m=2`). Se distingue a proposito para que un cliente pueda **no dibujar el boton** en vez
    de ofrecer uno que defrauda.
    """
    url = f"https://{doorbell_hostname(device_id)}:8443/open?token={quote(credential)}"
    try:
        async with session.get(url, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 409:
                raise NoLockConfiguredError("That doorbell has no lock configured (door_m=2)")
            if resp.status != 200:
                raise DoorbellApiError(f"GET /open -> HTTP {resp.status}")
    except aiohttp.ClientError as err:
        raise DoorbellApiError(f"Could not reach the doorbell to open: {err}") from err


async def async_set_hass_config(
    session: aiohttp.ClientSession,
    device_id: str,
    credential: str,
    *,
    url_webhook: str,
    entities: list[dict[str, str]],
) -> None:
    """POST /api/hass (contrato §4). **Solo HTTPS 8443**, y exige rol admin.

    Le dice al portero **a donde mandar sus avisos** y **que entidades de Home Assistant puede
    accionar**. Una `url_webhook` vacia lo desconfigura, que es como se desempareja Home Assistant.

    ⚠️ LA URL TIENE QUE SER LA INTERNA. `get_url(hass)` puede devolver la externa, y entonces el
    portero saldria a internet para hablar con una maquina que tiene en la LAN de al lado --
    rompiendo el principio 1 sin dar ningun error, solo dejando de funcionar el dia que se caiga la
    linea. En la instalacion de Inaki eso ya pasaria: su `internal_url` es un hostname publico.
    """
    api_url = (
        f"https://{doorbell_hostname(device_id)}:8443"
        f"/api/hass?token={quote(credential)}"
    )
    cuerpo = {"url": url_webhook, "entities": entities}
    try:
        async with session.post(api_url, json=cuerpo, timeout=_TIMEOUT) as resp:
            if resp.status == 401:
                raise AuthenticationError("Pairing credential rejected by the doorbell")
            if resp.status == 403:
                raise NotAllowedError("This pairing is not an admin of that doorbell")
            if resp.status != 200:
                cuerpo_err = await resp.text()
                raise DoorbellApiError(f"POST /api/hass -> HTTP {resp.status}: {cuerpo_err[:120]}")
    except aiohttp.ClientError as err:
        raise DoorbellApiError(f"Could not reach the doorbell to configure it: {err}") from err


class NoLockConfiguredError(DoorbellApiError):
    """`door_m=2`: ese portero no tiene cerradura. NO es un fallo de la peticion.

    Distinto de un error generico a proposito, por el mismo motivo que el firmware lo distingue:
    un cliente necesita poder **no dibujar el boton de abrir** en vez de ofrecer uno que defrauda
    (§1.4-ter). Antes de que `door_m` viajara, la unica forma de saberlo era fallar una vez.
    """
