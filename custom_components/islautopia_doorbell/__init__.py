"""The Islautopia Doorbell integration.

Four runtime responsibilities - see ARCHITECTURE.md §3 for the reasoning behind what this
integration does NOT do:

  1. Receive what the doorbell has to say, over a webhook, and turn it into entities and events -
     webhook.py plus the entity platforms. This replaced MQTT on 2026-08-24.
  2. Ask the doorbell how it is, so those entities have state - coordinator.py.
  3. Credential broker for the Lovelace card (pairing done once in config_flow.py, TURN
     credentials served on demand) - websocket_api.py - and relaying its signalling so the card
     never has to reach the doorbell's public hostname - signal_proxy.py.
  4. Config flow itself (Zeroconf discovery + manual entry, no YAML) - config_flow.py.

## Why this integration owns the entities now

It did not use to. Every entity a user saw - mode, doorbell, door, presence - was published by the
firmware's own MQTT discovery, and this integration set up no platforms at all. MQTT is gone
(API_CONTRACT.md §4), and the reason is not technical: a broker is a prerequisite half the audience
does not meet, and this has to work on a Home Assistant somebody installed this morning, exactly
the way the apps do.

What unblocked it is smaller than it sounds. `get_states` took a session cookie and nothing else,
and this integration holds a pairing credential and never the administrator's password - which is
precisely what pairing exists to avoid. So it could not read the doorbell's own state to build a
single entity. The firmware fixed that the same day (§1.2); see api.py.

IMPORTANT (found via real-hardware testing 2026-07-09): the device registered here still carries
the identifier the firmware's old MQTT discovery used, alongside our own. There is nothing left to
merge with today - but a Home Assistant that still carries the old MQTT-published entities would
otherwise end up with two disconnected devices for one physical doorbell.
"""
from __future__ import annotations

import logging
from ipaddress import ip_address
from urllib.parse import urlparse

from homeassistant.components import network
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.network import NoURLAvailableError, get_url

from . import api, net, webhook
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_ENTIDADES,
    CONF_HOST_HINT,
    DOMAIN,
)
from .coordinator import DoorbellCoordinator
from .signal_proxy import async_register_signal_proxy
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[str] = ["binary_sensor", "button", "event", "select", "sensor"]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register integration-wide resources once, regardless of how many entries get added."""
    async_register_websocket_commands(hass)
    async_register_signal_proxy(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one paired doorbell."""
    hass.data.setdefault(DOMAIN, {})

    # Register a device purely so this doorbell shows up in HA's own device registry - the
    # Lovelace card's editor uses the native `ha-selector` device picker (filtered to this
    # integration) to let the user pick a doorbell without ever typing/copying a device_id by
    # hand, and that picker only lists devices that actually exist in the registry.
    #
    # ONE identifier: our own. The card editor's device picker looks up exactly this pair in
    # `device.identifiers`, which is why the device is registered here at all.
    #
    # ⚠️ IT USED TO CARRY A SECOND ONE - the identifier the firmware's old MQTT discovery used -
    # so that Home Assistant would MERGE our device with the one the `mqtt` integration created for
    # the same physical doorbell. That was right while both existed, and it is removed now, because
    # it turned out to cost something I had written down as costing nothing.
    #
    # Measured on 2026-08-24, on a real installation: deleting the doorbell's MQTT device took THIS
    # INTEGRATION'S CONFIG ENTRY with it - the two shared a device, so removing the device removed
    # the entry attached to it. The webhook went with it, the doorbell carried on writing to an
    # address nobody was listening at, and the door stopped opening. Nothing said why; the only
    # trace was `async_remove_entry` logging that it could not unconfigure the webhook.
    #
    # And a second half that only got away with it by luck: that same removal path TELLS THE
    # DOORBELL TO STOP WRITING. It failed today because the removed entry's credential was already
    # dead. With a live one it would have succeeded - and the doorbell would have gone quiet
    # because of a deletion the user never aimed at us.
    #
    # The merge bought nothing any more: the firmware stopped speaking MQTT that same morning. An
    # installation upgrading from before will keep its old MQTT entities as a separate, unavailable
    # device, which is honest - they are not ours and nothing feeds them.
    #
    # Deliberately do NOT pass `name=` here (found via real-hardware testing 2026-07-09):
    # `async_get_or_create` only overwrites the stored device name when `name` is explicitly
    # passed, and passing our own entry.title on EVERY setup/reload would stomp the real
    # user-configured `device_name` (§0-bis) - which the entities publish from `dname`, the actual
    # source of truth (see entity.py). Omitting it means HA still names a brand-new device from
    # this entry's title, and our reloads never overwrite it again.
    device_registry = dr.async_get(hass)
    device_registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, entry.data[CONF_DEVICE_ID])},
        manufacturer="Islautopia",
        model="IG Doorbell",
    )

    device_id = entry.data[CONF_DEVICE_ID]

    # A donde conectar para hablar con ESTE portero. La URL sigue llevando su hostname publico,
    # asi que el certificado se valida contra el igual que siempre; lo unico que esto cambia es la
    # direccion a la que se abre el socket, y con ella que Home Assistant deje de necesitar DNS
    # publico para alcanzar un aparato que tiene en la misma red. El porque entero, en net.py.
    #
    # Una direccion nueva -- zeroconf, o el usuario cambiandola-- llega como una actualizacion de
    # la entrada, y `_async_update_listener` recarga la integracion entera: se cierra esta sesion y
    # se crea otra con el mapeo nuevo. No hace falta que nada mute lo de aqui en caliente.
    mapeo = {}
    pista = entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT)
    if pista:
        mapeo[api.doorbell_hostname(device_id)] = pista
    else:
        # No es un fallo, y por eso no se avisa a gritos: un portero emparejado a mano por su
        # hostname nunca dio una direccion local. Funciona igual mientras haya internet -- que es
        # justo la dependencia que se queria quitar, asi que conviene que se pueda ver.
        _LOGGER.debug(
            "Sin direccion local para %s: se ira por DNS publico, o sea que hara falta internet "
            "para hablar con el portero desde esta misma red",
            device_id,
        )
    sesion = net.crear_sesion(hass, mapeo)

    coordinator = DoorbellCoordinator(
        hass, entry, device_id, entry.data[CONF_CREDENTIAL], sesion
    )

    # ⚠️ `async_refresh()` y NO `async_config_entry_first_refresh()`, y es deliberado.
    #
    # El segundo ABORTA el arranque de la entrada si el portero no contesta. Y esta entrada hace
    # ademas de intermediaria de credenciales de la card (websocket_api.py), asi que un portero
    # apagado un momento se llevaria por delante **tambien la card** -- que es una regresion
    # respecto a como funcionaba esto con MQTT, donde el arranque siempre salia adelante.
    #
    # Con `async_refresh()` la entrada arranca siempre: si el portero no esta, sus entidades salen
    # como no disponibles (entity.py), que es exactamente lo que significa, y la card sigue
    # funcionando.
    await coordinator.async_refresh()

    webhook_id = await webhook.async_registrar(hass, device_id, coordinator.nombre_portero)

    hass.data[DOMAIN][entry.entry_id] = {
        **dict(entry.data),
        "coordinator": coordinator,
        "webhook_id": webhook_id,
        "sesion": sesion,
    }

    if not await _async_configurar_portero(hass, entry, coordinator, primera_vez=True):
        _programar_reintento(hass, entry, coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_configurar_portero(
    hass: HomeAssistant,
    entry: ConfigEntry,
    coordinator: DoorbellCoordinator,
    *,
    primera_vez: bool = False,
) -> bool:
    """Le dice al portero a donde mandar sus avisos y que entidades puede accionar (§4).

    La direccion que se le da tiene que ser alcanzable **sin DNS**. Ver `_base_local`, que es donde
    vive ese problema y por que `get_url()` no basta para resolverlo.
    """
    base = await _base_local(hass)
    if base is None:
        _LOGGER.error(
            "Home Assistant no sabe cual es su propia direccion en la red local, asi que no se le "
            "puede decir al portero a donde escribir. Ponla en Ajustes > Sistema > Red > "
            "«Direccion de Home Assistant» y recarga esta integracion."
        )
        # No se programa reintento: esto no se arregla porque el portero conteste, se
        # arregla cuando alguien configure esa direccion -- y eso ya recarga la integracion.
        return True

    url_webhook = f"{base.rstrip('/')}/api/webhook/{webhook.webhook_id_de(coordinator.device_id)}"
    entidades = entry.options.get(CONF_ENTIDADES) or []
    lista = [{"id": e, "name": _nombre_visible(hass, e)} for e in entidades]

    try:
        await api.async_set_hass_config(
            coordinator.sesion,
            coordinator.device_id,
            entry.data[CONF_CREDENTIAL],
            url_webhook=url_webhook,
            entities=lista,
        )
    except api.NotAllowedError:
        # Se dice y NO se reintenta: reemparejar desde una sesion de administrador es lo unico que
        # lo arregla, y un bucle de reintentos solo llenaria el registro de algo que no va a
        # cambiar solo.
        _LOGGER.error(
            "Este emparejamiento no es administrador de %s, asi que no puede configurar el "
            "webhook. Vuelve a emparejarlo desde una sesion de administrador.",
            coordinator.device_id,
        )
        return True
    except api.DoorbellApiError as err:
        # No es fatal: las entidades siguen funcionando por sondeo. Lo que se pierde es lo que
        # llega EMPUJADO -- el timbrazo, el paquete-- asi que se dice claramente en vez de dejar al
        # usuario preguntandose por que no salta nada, y se reintenta en cuanto el portero vuelva.
        if primera_vez:
            _LOGGER.warning(
                "No se pudo configurar el webhook en %s (%s). Se reintentara en cuanto el portero "
                "vuelva a contestar; hasta entonces las entidades funcionan por sondeo pero los "
                "avisos en vivo no llegaran.",
                coordinator.device_id, err,
            )
        return False

    _LOGGER.info(
        "Webhook configurado en %s: %s (%d entidad(es) accionables)",
        coordinator.device_id, url_webhook, len(lista),
    )
    return True


async def _base_local(hass: HomeAssistant) -> str | None:
    """La direccion de Home Assistant que el portero puede alcanzar SIN DNS.

    ⚠️ `get_url(allow_external=False)` NO garantiza eso, y darlo por hecho fue un error mio. Esa
    bandera solo dice *no uses la externa*: si el `internal_url` configurado es a su vez un nombre
    publico, lo devuelve tal cual. **En el Home Assistant de Inaki es exactamente el caso** --
    `internal_url` y `external_url` valen los dos `https://hass.islautopia.com`-- asi que la
    primera instalacion real habria mandado al portero a salir a internet, DNS al menos, para
    hablar con una maquina que tiene en la LAN de al lado. Eso rompe el principio 1 **sin dar
    ningun error**: solo deja de funcionar el dia que se caiga la linea.

    Por eso se prefiere **la IP** con la que esta maquina sale a la red, que es lo unico que no
    necesita que nada resuelva un nombre. `get_url` se queda de respaldo, con su aviso.
    """
    # 1) La IP de esta maquina en su propia red.
    try:
        ip = await network.async_get_source_ip(hass, network.PUBLIC_TARGET_IP)
    except Exception:  # noqa: BLE001 - cualquier fallo aqui solo significa "usa el respaldo"
        ip = None
    if ip:
        esquema = "https" if getattr(hass.http, "use_ssl", False) else "http"
        return f"{esquema}://{ip}:{hass.http.server_port}"

    # 2) Respaldo: lo que Home Assistant crea que es su direccion interna.
    try:
        base = get_url(hass, allow_external=False, allow_cloud=False,
                       allow_ip=True, prefer_external=False)
    except NoURLAvailableError:
        return None

    anfitrion = urlparse(base).hostname or ""
    try:
        ip_address(anfitrion)
    except ValueError:
        # Es un NOMBRE, no una direccion. Puede funcionar perfectamente -- su DNS local puede
        # resolverlo dentro de casa-- asi que no se rechaza. Pero se dice, porque es la diferencia
        # entre "funciona" y "funciona mientras haya quien resuelva ese nombre".
        _LOGGER.warning(
            "La direccion que Home Assistant da de si mismo es un NOMBRE (%s), no una IP de la "
            "red local. El videoportero tendra que resolverlo para poder avisar, asi que si ese "
            "nombre solo existe en internet, los avisos dejaran de llegar en cuanto se caiga la "
            "linea -- dentro de casa, y sin ningun error. Ponle una direccion local en Ajustes > "
            "Sistema > Red.",
            anfitrion,
        )
    return base


def _programar_reintento(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Vuelve a intentar la configuracion en cuanto el portero conteste.

    Hace falta porque el caso normal de fallo es **el portero apagado cuando arranca Home
    Assistant**, y ahi no hay nada que dispare un segundo intento: el sondeo se recupera solo, pero
    la configuracion del webhook es una escritura de una sola vez. Sin esto, un corte de luz de
    madrugada deja el portero sin saber a donde escribir hasta que alguien recargue la integracion
    a mano -- y el sintoma seria «los avisos ya no llegan», que nadie relaciona con un apagon.
    """
    cancelar: list = []

    @callback
    def _cuando_conteste() -> None:
        if not coordinator.last_update_success:
            return
        # Se suelta el enganche ANTES de reintentar: si no, un fallo del reintento volveria a
        # entrar aqui en el sondeo siguiente y se acumularian intentos solapados.
        if cancelar:
            cancelar.pop()()
        hass.async_create_task(_reintentar(hass, entry, coordinator))

    cancelar.append(coordinator.async_add_listener(_cuando_conteste))
    entry.async_on_unload(lambda: cancelar and cancelar.pop()())


async def _reintentar(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    if not await _async_configurar_portero(hass, entry, coordinator):
        _programar_reintento(hass, entry, coordinator)


def _nombre_visible(hass: HomeAssistant, entity_id: str) -> str:
    """El nombre que una persona reconoce, para el desplegable de las apps.

    `light.porche_2` no le dice nada a nadie, y ese desplegable lo lee **del portero**, no de Home
    Assistant -- las apps no hablan con HA ni tienen por que (§4). Si la entidad no existe todavia
    se manda su propio `entity_id`: un desplegable con una entrada en blanco no se puede elegir, y
    eso es peor que uno con un nombre feo.
    """
    estado = hass.states.get(entity_id)
    if estado is None:
        return entity_id
    return estado.attributes.get("friendly_name") or entity_id


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        webhook.desregistrar(hass, entry.data[CONF_DEVICE_ID])
        datos = hass.data[DOMAIN].pop(entry.entry_id, None)
        # La sesion es de ESTA entrada y no tiene limpieza automatica a proposito (net.py): la que
        # trae Home Assistant salta al PARAR, y una integracion se descarga y recarga muchas veces
        # antes de eso. Sin este cierre, cada recarga deja un conector y su hilo de resolucion.
        if datos and (sesion := datos.get("sesion")):
            await sesion.close()
    return ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Al DESINSTALAR: se le dice al portero que deje de escribir aqui.

    ⚠️ ESTO NO ES CORTESIA: es la otra mitad de la marca que devuelve el webhook. Home Assistant
    contesta `200` a un webhook que ya no existe -- a proposito, para que nadie pueda enumerarlos--
    asi que un portero al que no se le dice nada seguiria disparando al vacio para siempre. La
    marca convierte ese fallo invisible en uno visible; esto es lo que evita que exista.

    Best-effort: si el portero no esta alcanzable ahora mismo, se dice y se sigue. Impedir que
    alguien desinstale una integracion porque un aparato esta apagado seria peor.
    """
    mapeo = {}
    pista = entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT)
    if pista:
        mapeo[api.doorbell_hostname(entry.data[CONF_DEVICE_ID])] = pista
    sesion = net.crear_sesion(hass, mapeo)
    try:
        await api.async_set_hass_config(
            sesion,
            entry.data[CONF_DEVICE_ID],
            entry.data[CONF_CREDENTIAL],
            url_webhook="",
            entities=[],
        )
        _LOGGER.info("Webhook desconfigurado en %s", entry.data[CONF_DEVICE_ID])
    except api.DoorbellApiError as err:
        _LOGGER.warning(
            "No se pudo desconfigurar el webhook en %s (%s). Ese portero seguira mandando avisos "
            "a una direccion que ya no escucha nadie hasta que se le vuelva a configurar.",
            entry.data[CONF_DEVICE_ID], err,
        )
    finally:
        # Esta sesion es de usar y tirar y NO la limpia nadie: en `async_remove_entry` ya no hay
        # entrada en `hass.data`, porque la descarga corre antes. Sin este cierre, cada
        # desinstalacion deja un conector abierto y el hilo de resolucion detras.
        await sesion.close()


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Recarga la entrada cuando cambian sus datos o sus opciones.

    Recargar entera y no parchear a mano: al cambiar la lista de entidades hay que volver a
    empujarla al portero, y el webhook hay que volver a registrarlo con el nombre nuevo. Hacerlo
    por partes es como se acaba con la mitad de la configuracion vieja y la mitad nueva.
    """
    await hass.config_entries.async_reload(entry.entry_id)
