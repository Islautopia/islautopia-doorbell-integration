"""The IG Doorbell integration.

Four runtime responsibilities - see ARCHITECTURE.md §3 for the reasoning behind what this
integration does NOT do:

  1. Receive what the doorbell has to say, over a webhook, and turn it into entities and events -
     webhook.py plus the entity platforms. This replaced MQTT on 2026-08-24.
  2. Ask the doorbell how it is, so those entities have state - coordinator.py.
  3. Server side of the Lovelace card: relays its signalling (signal_proxy.py) and its recordings
     (recordings_view.py) so the pairing credential never reaches a browser, and tells it which
     entities to read (websocket_api.py). LAN only: nothing here talks to the VPS (net.py).
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

import asyncio
import logging
import socket
from ipaddress import ip_address, ip_network
from urllib.parse import urlparse


from homeassistant.components import network, persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.network import NoURLAvailableError, get_url

from . import api, net, webhook
from .const import (
    CONF_CREDENTIAL,
    CONF_DEVICE_ID,
    CONF_ENTIDADES,
    CONF_HOST_HINT,
    DOMAIN,
    DOMINIOS_PERMITIDOS,
    DOORBELL_HOSTNAME_SUFFIX,
    MAX_ENTIDADES,
)
from .coordinator import DoorbellCoordinator
from .recordings_view import async_register_recordings_view
from .services import async_register_services
from .signal_proxy import async_register_signal_proxy
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[str] = ["binary_sensor", "button", "event", "number", "select", "sensor", "switch"]


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register integration-wide resources once, regardless of how many entries get added."""
    async_register_websocket_commands(hass)
    async_register_signal_proxy(hass)
    async_register_recordings_view(hass)
    async_register_services(hass)
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

    # WHERE this doorbell lives: its LAN address, and nothing else (net.py). There is no longer a
    # public-DNS fallback to "learn" a new address from (Phase 0, 2026-09-25): a moved doorbell is
    # found again by zeroconf, or the user sets the address in the options flow.
    hostname = api.doorbell_hostname(device_id)
    direccion = await _direccion_lan(hass, entry)

    mapeo = {hostname: direccion} if direccion else {}
    if not direccion:
        _LOGGER.error(
            "No LAN address stored for doorbell %s. Home Assistant only talks to the doorbell over "
            "the local network: set its address in the integration options (Doorbell address).",
            device_id,
        )
    else:
        sondeo = net.crear_sesion(hass, {})
        try:
            if not await net.es_este_portero(sondeo, direccion, device_id):
                # Not an error by itself: the doorbell may be powered off. Said at INFO so a moved
                # doorbell is diagnosable; the entities go unavailable, which is what it means.
                _LOGGER.info(
                    "Doorbell %s does not answer at %s right now (off, or moved: zeroconf or the "
                    "options flow will update the address).", device_id, direccion,
                )
        finally:
            await sondeo.close()

    sesion = net.crear_sesion(hass, mapeo)

    coordinator = DoorbellCoordinator(
        hass, entry, device_id, entry.data[CONF_CREDENTIAL], sesion, direccion
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

    # ⚠️ AQUI y no mas abajo: el oyente de actualizaciones (linea de mas abajo,
    # `entry.add_update_listener`) todavia no esta registrado, asi que esta primera correccion NO
    # dispara una recarga (Inaki, 2026-09-26: "el nombre del portero si es util, el id despista
    # mucho"). Corrige sola cualquier entrada vieja que se llame por su device_id -- la de Ermita
    # entre ellas -- en cuanto arranca esta version, sin esperar a que el nombre del portero
    # cambie. Ver `_sincronizar_nombre`.
    _sincronizar_nombre(hass, entry, coordinator)

    webhook_id = await webhook.async_registrar(hass, device_id, coordinator.nombre_portero)

    hass.data[DOMAIN][entry.entry_id] = {
        **dict(entry.data),
        "coordinator": coordinator,
        "webhook_id": webhook_id,
        "sesion": sesion,
    }

    _adoptar_entidad_de_la_puerta(hass, entry, coordinator)
    if not await _async_configurar_portero(hass, entry, coordinator, primera_vez=True):
        _programar_reintento(hass, entry, coordinator)
    _vigilar_entidades(hass, entry, coordinator)
    _vigilar_nombre(hass, entry, coordinator)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _direccion_lan(hass: HomeAssistant, entry: ConfigEntry) -> str | None:
    """The stored LAN address as a literal IP.

    Entries created before 0.7.0 may hold a NAME the user typed. A LOCAL name is resolved once
    through the system resolver (the home's own DNS), and the address is stored so the next setup
    needs no lookup. A name under our cloud's domain is refused: resolving it is asking the VPS.
    """
    guardada = entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT)
    if not guardada or net.es_direccion(guardada):
        return guardada or None
    if guardada.lower().rstrip(".").endswith(DOORBELL_HOSTNAME_SUFFIX):
        _LOGGER.error(
            "The stored address of %s is the cloud hostname %s. Home Assistant no longer resolves "
            "it (LAN only): set the doorbell's IP in the integration options.",
            entry.data[CONF_DEVICE_ID], guardada,
        )
        return None
    try:
        info = await asyncio.get_running_loop().getaddrinfo(
            guardada, 80, family=socket.AF_INET, type=socket.SOCK_STREAM
        )
    except OSError:
        return None
    if not info:
        return None
    direccion = info[0][4][0]
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_HOST_HINT: direccion})
    return direccion


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
    base = await _base_local(hass, entry.data.get(CONF_HOST_HINT) or entry.options.get(CONF_HOST_HINT))
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
    entidades = _entidades_validas(entry.options.get(CONF_ENTIDADES) or [], coordinator.device_id)
    # `domain` viaja aunque el portero lo pueda derivar del id: lo comprueba contra el id, y asi un
    # desacuerdo se ve en vez de elegir uno en silencio (contrato 4).
    lista = [
        {"id": e, "name": _nombre_visible(hass, e), "domain": e.split(".", 1)[0]}
        for e in entidades
    ]

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

    _NOMBRES_EMPUJADOS[entry.entry_id] = {e["id"]: e["name"] for e in lista}
    _LOGGER.info(
        "Webhook configurado en %s: %s (%d entidad(es) accionables)",
        coordinator.device_id, url_webhook, len(lista),
    )
    return True


# Lo ultimo que se le dijo a cada portero de cada entidad: su nombre visible. Sirve para no volver a
# empujar la lista por cada cambio de ESTADO de una luz -- solo cuando cambia lo que el portero
# guarda.
_NOMBRES_EMPUJADOS: dict[str, dict[str, str]] = {}


def _entidades_validas(entidades: list[str], device_id: str) -> list[str]:
    """La lista tal como se le puede dar al portero: dominios permitidos, sin repetir, hasta 5.

    ⚠️ Una lista guardada por la 0.7.5 puede traer 24 entidades, o un `button`: el portero la
    rechazaria ENTERA (`too_many_entities`, `bad_entity_domain`) y con ella la URL del webhook, que
    viaja en la misma peticion -- o sea que actualizar la integracion dejaria la casa sin avisos. Se
    manda la parte valida y SE DICE en el registro; el formulario de opciones ya solo deja elegir
    lo valido.
    """
    validas: list[str] = []
    for e in entidades:
        if e.split(".", 1)[0] in DOMINIOS_PERMITIDOS and e not in validas:
            validas.append(e)
    fuera = [e for e in entidades if e not in validas]
    if len(validas) > MAX_ENTIDADES:
        fuera += validas[MAX_ENTIDADES:]
        validas = validas[:MAX_ENTIDADES]
    if fuera:
        _LOGGER.warning(
            "%s: estas entidades NO se le dan al portero (solo se admiten %s, y %d como maximo): "
            "%s. Revisa las opciones de la integracion.",
            device_id, ", ".join(DOMINIOS_PERMITIDOS), MAX_ENTIDADES, ", ".join(fuera),
        )
    return validas


def _adoptar_entidad_de_la_puerta(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Una sola vez al actualizar: la entidad con la que YA se abre la puerta entra en la lista.

    ⚠️ SIN ESTO, ACTUALIZAR A LA 0.7.6 DEJA LA PUERTA SIN ABRIR. Hasta la 0.7.5 `ha_e` se escribia a
    mano en el portero y no tenia por que estar en la lista de esta integracion (que en muchas
    instalaciones esta vacia). Desde la 0.7.6 esta integracion solo acciona entidades de su lista,
    asi que la orden de abrir se rechazaria (`not_listed`) sin que el dueno hubiera tocado nada.

    Adoptarla no amplia nada: es la entidad que el administrador ya eligio para la puerta. Se hace
    ANTES de registrar el oyente de opciones (por eso no recarga) y se dice en el registro. Si su
    dominio ya no se admite, NO se adopta: se avisa con una notificacion persistente, porque la
    puerta va a dejar de abrir y el dueno tiene que saberlo antes de estar delante de ella.

    Mismo destino que el oyente de opciones: se elimina el dia que ninguna instalacion venga de la
    0.7.5.
    """
    datos = coordinator.data or {}
    ha_e = datos.get("ha_e") or ""
    if datos.get("door_m") != 1 or not ha_e:
        return
    actuales = list(entry.options.get(CONF_ENTIDADES) or [])
    if ha_e in actuales:
        return
    if ha_e.split(".", 1)[0] not in DOMINIOS_PERMITIDOS:
        _LOGGER.error(
            "La puerta de %s se abre con %s, y ese tipo de entidad ya no se admite (solo %s). "
            "La puerta NO se abrira por Home Assistant hasta que se elija otra.",
            coordinator.device_id, ha_e, ", ".join(DOMINIOS_PERMITIDOS),
        )
        persistent_notification.async_create(
            hass,
            f"The door of doorbell {coordinator.device_id} opens with `{ha_e}`, and that kind of "
            f"entity is no longer accepted (only {', '.join(DOMINIOS_PERMITIDOS)}). The door will "
            "NOT open through Home Assistant until another entity is picked in the integration "
            "options and then in the doorbell's door settings.",
            title="IG Doorbell: door entity not accepted",
            notification_id=f"{DOMAIN}_{coordinator.device_id}_ha_e",
        )
        return
    validas = [e for e in actuales if e.split(".", 1)[0] in DOMINIOS_PERMITIDOS]
    if len(validas) >= MAX_ENTIDADES:
        _LOGGER.error(
            "La puerta de %s se abre con %s, que no esta en la lista de entidades y la lista ya "
            "tiene %d: la puerta NO se abrira por Home Assistant hasta que se anada.",
            coordinator.device_id, ha_e, MAX_ENTIDADES,
        )
        return
    hass.config_entries.async_update_entry(
        entry, options={**entry.options, CONF_ENTIDADES: [*actuales, ha_e]}
    )
    _LOGGER.warning(
        "%s: la entidad con la que se abre la puerta (%s) se ha anadido a la lista de entidades "
        "que puede accionar el portero, para que siga abriendo con la 0.7.6.",
        coordinator.device_id, ha_e,
    )


def _sincronizar_nombre(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """El titulo de la entrada y el nombre del dispositivo siguen al nombre del portero (`dname`).

    Iñaki, 2026-09-26: *"el nombre del portero si es util, el id despista mucho"* -- buscando
    donde configurar sus entidades no reconocio la entrada de Ermita porque en Ajustes >
    Dispositivos y servicios se llamaba `f9b31fc3bb64bc26` (su `device_id`), no "Ermita" ni nada
    parecido. `coordinator.nombre_portero` ya resuelve `dname` (o el generico del firmware si no
    hay uno, nunca el id a secas - const.py), asi que solo hace falta empujarlo a los dos sitios
    que Home Assistant muestra por separado.

    Solo toca `name` en el registro de dispositivo, NUNCA `name_by_user`: si el propio Iñaki
    renombra el dispositivo a mano en Home Assistant, eso se guarda aparte y HA lo sigue
    mostrando por encima de esto (es el mecanismo nativo para "el usuario ya lo dijo, no lo
    machaques"). Y no toca ningun `entity_id`: solo el nombre visible del dispositivo cambia, que
    es de donde las entidades con `has_entity_name` componen su nombre visible en cada lectura --
    no hay que tocarlas una a una.
    """
    nombre = coordinator.nombre_portero
    if entry.title != nombre:
        hass.config_entries.async_update_entry(entry, title=nombre)

    registro = dr.async_get(hass)
    dispositivo = registro.async_get_device(identifiers={(DOMAIN, coordinator.device_id)})
    if dispositivo is not None and dispositivo.name != nombre:
        registro.async_update_device(dispositivo.id, name=nombre)


def _vigilar_nombre(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Vuelve a comprobar el nombre del portero en cada sondeo, para pillar un cambio posterior.

    ⚠️ Esto se llama DESPUES de registrar `entry.add_update_listener` (mas abajo en
    `async_setup_entry`), asi que aqui si un cambio de nombre real recarga la entrada -- igual que
    un cambio de opciones. No es un efecto secundario que haya que evitar: es el mismo patron que
    `_vigilar_entidades` ya usa para las entidades, y `async_update_entry` no hace nada (ni
    dispara la recarga) si el nombre no ha cambiado desde la ultima vez.
    """

    @callback
    def _al_actualizar() -> None:
        _sincronizar_nombre(hass, entry, coordinator)

    entry.async_on_unload(coordinator.async_add_listener(_al_actualizar))


def _vigilar_entidades(
    hass: HomeAssistant, entry: ConfigEntry, coordinator: DoorbellCoordinator
) -> None:
    """Mantiene al dia la lista del portero cuando las entidades cambian EN Home Assistant.

    - **Cambia el nombre visible** (el usuario la renombra, o renombra el dispositivo): se vuelve a
      empujar la lista, para que el desplegable de las apps diga lo mismo que HA.
    - **Cambia el `entity_id`**: se sustituye en las opciones, y la recarga lo empuja.
    - **Se borra**: se quita de las opciones, y la recarga lo empuja. El portero marca entonces lo
      que la usaba (`ha_e_ok: false`, `not_listed` en el paso) en vez de fallar en silencio.
    """
    entidades = _entidades_validas(entry.options.get(CONF_ENTIDADES) or [], coordinator.device_id)
    pendiente: list = []

    @callback
    def _reempujar_pronto() -> None:
        # Un renombrado de dispositivo cambia varias entidades a la vez: se agrupa en un envio.
        if pendiente:
            return

        async def _ya(_ahora) -> None:
            pendiente.clear()
            if not await _async_configurar_portero(hass, entry, coordinator):
                _programar_reintento(hass, entry, coordinator)

        pendiente.append(async_call_later(hass, 2, _ya))

    @callback
    def _estado(event: Event) -> None:
        eid = event.data["entity_id"]
        nuevo = event.data.get("new_state")
        nombre = (nuevo.attributes.get("friendly_name") if nuevo else None) or eid
        if nombre != _NOMBRES_EMPUJADOS.get(entry.entry_id, {}).get(eid):
            _reempujar_pronto()

    @callback
    def _registro(event: Event) -> None:
        accion = event.data.get("action")
        eid = event.data.get("entity_id")
        actuales = list(entry.options.get(CONF_ENTIDADES) or [])
        if accion == "remove" and eid in actuales:
            actuales.remove(eid)
            _LOGGER.warning("%s se ha borrado de Home Assistant: sale de la lista del portero %s",
                            eid, coordinator.device_id)
        elif accion == "update" and event.data.get("old_entity_id") in actuales:
            actuales[actuales.index(event.data["old_entity_id"])] = eid
        else:
            return
        # Cambiar las opciones dispara la recarga (`_async_update_listener`), que vuelve a empujar
        # la lista y a vigilar las entidades nuevas. Un solo camino, no dos.
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, CONF_ENTIDADES: actuales}
        )

    if entidades:
        entry.async_on_unload(async_track_state_change_event(hass, entidades, _estado))
    entry.async_on_unload(hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, _registro))
    entry.async_on_unload(lambda: pendiente and pendiente.pop()())


# Redes internas de contenedores que Home Assistant OS / Supervised crea para si mismo. Una
# direccion de aqui es valida DENTRO de la maquina y inalcanzable desde la LAN (ver `_base_local`).
_REDES_CONTENEDORES = (ip_network("172.30.32.0/23"), ip_network("172.17.0.0/16"))


def _es_red_interna_de_contenedores(ip: str) -> bool:
    try:
        direccion = ip_address(ip)
    except ValueError:
        return False
    return any(direccion in red for red in _REDES_CONTENEDORES)


async def _base_local(hass: HomeAssistant, destino: str | None = None) -> str | None:
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
    # 1) La IP con la que esta maquina LLEGA AL PORTERO.
    #
    # ⚠️ Se pregunta la ruta hacia el portero, no hacia internet. Hasta el 2026-09-16 se usaba
    # `PUBLIC_TARGET_IP`, y el 15-09 Home Assistant arranco con la linea caida (PPPoE abajo a la
    # vez que se reinicio): sin ruta a internet, la IP de salida fue la del puente interno de
    # Docker del Supervisor (172.30.32.1). Se le mando al portero, y la puerta dejo de abrir
    # --sin ningun error visible-- hasta que alguien lo noto al dia siguiente. Una direccion de
    # esos puentes nunca es alcanzable desde la LAN, asi que ademas se rechaza explicitamente.
    ip = None
    for objetivo in (destino, network.PUBLIC_TARGET_IP):
        if not objetivo:
            continue
        try:
            candidata = await network.async_get_source_ip(hass, objetivo)
        except Exception:  # noqa: BLE001 - cualquier fallo aqui solo significa "prueba la siguiente"
            candidata = None
        if candidata and not _es_red_interna_de_contenedores(candidata):
            ip = candidata
            break
        if candidata:
            _LOGGER.warning(
                "La IP de salida hacia %s es %s, de una red interna de contenedores: el portero no "
                "puede llegar a ella, asi que no se le da.", objetivo, candidata)
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
    if net.es_direccion(pista):
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
