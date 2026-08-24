"""El portero avisa a Home Assistant por webhook (API_CONTRACT.md §4).

Sustituye a MQTT, y el motivo no es tecnico sino de producto: MQTT obligaba al usuario a tener un
broker instalado, y esta integracion tiene que funcionar en un Home Assistant recien instalado,
igual que funcionan las apps. Un requisito previo que la mitad de la gente no cumple no es una
integracion: es un manual.

Lo que llega es **el sobre de §3.6.1 sin cambiar una coma**, el mismo que el portero ya compone
para el relay. Un formato propio para Home Assistant seria un quinto dialecto que mantener.

## ⚠️ POR QUE ESTE HANDLER DEVUELVE UN CUERPO, Y NO ES UNA CORTESIA

Medido el 2026-08-24 contra un Home Assistant real: **contesta `200` a un webhook que NO existe**,
con el cuerpo vacio. Es deliberado por su parte -- asi nadie puede enumerar los webhook de una
instalacion probandolos.

Consecuencia: por codigo de estado el portero **no puede distinguir** «entregado» de «Home
Assistant se olvido de mi». Un portero cuya integracion se borro seguiria disparando al vacio para
siempre con su contador de fallos en cero -- los dos extremos diciendo que todo va bien y nada
ocurriendo, que es la familia de fallo que este proyecto persigue.

**La marca del cuerpo es lo unico que rompe ese empate.** Y un handler de Home Assistant que
devuelve `None` produce **tambien** un 200 vacio, asi que devolverla es un REQUISITO: olvidarse del
cuerpo hace que el portero de por muerta una integracion perfectamente viva.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from aiohttp import web
from homeassistant.components import webhook
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import (
    DOMAIN,
    DOMAIN_CLOSE_SERVICE,
    DOMAIN_OPEN_SERVICE,
    FALLBACK_SERVICE,
    SIGNAL_EVENTO,
    WEBHOOK_MARCA,
)

_LOGGER = logging.getLogger(__name__)


def webhook_id_de(device_id: str) -> str:
    """El identificador del webhook, derivado del `device_id`.

    Derivado y no aleatorio a proposito: hace la operacion **idempotente**. Recargar la entrada de
    configuracion vuelve a registrar el mismo identificador, asi que la URL que el portero ya tiene
    guardada sigue siendo valida y no hay que reconfigurarlo en cada reinicio de Home Assistant.

    ⚠️ Y eso significa que **este identificador no es un secreto fuerte**: se puede derivar del
    `device_id`, que es publico (§0). Lo que lo protege es `local_only=True` mas abajo -- solo se
    acepta desde la propia red. Un identificador aleatorio seria mas secreto y obligaria a
    reconfigurar el portero cada vez que se perdiera, que es peor negocio para lo que hay en juego:
    lo que se puede hacer por aqui es contarle cosas a Home Assistant, no mandarle nada al portero.
    """
    return f"islautopia_doorbell_{device_id}"


async def _accionar_entidad(hass: HomeAssistant, entity_id: str, encender: bool) -> None:
    """`hass_action`: el portero pide encender o apagar una entidad de Home Assistant (§4).

    Es lo que hacia `videoportero/door/action` por MQTT, y **no es solo la puerta**: un paso de
    secuencia puede accionar cualquier entidad (§1.18.0).
    """
    dominio = entity_id.split(".", 1)[0] if "." in entity_id else ""
    tabla = DOMAIN_OPEN_SERVICE if encender else DOMAIN_CLOSE_SERVICE
    par = tabla.get(dominio)

    if par is None:
        if encender:
            # Un hueco de la tabla de apertura SI es un hueco: se grita para que se vea, en vez de
            # dejar un no-op silencioso.
            par = FALLBACK_SERVICE
            _LOGGER.warning(
                "Sin servicio de apertura para el dominio '%s' (%s): se usa %s.%s. "
                "Anade el dominio a DOMAIN_OPEN_SERVICE en const.py",
                dominio, entity_id, par[0], par[1],
            )
        else:
            # Un hueco de CIERRE es legitimo y no se grita: un boton no se "despulsa", y una escena
            # o un script son acciones de una sola vez sin estado opuesto al que volver. Forzarlos
            # con un servicio inventado seria peor que no hacer nada.
            _LOGGER.debug("El dominio '%s' no tiene un cierre natural: %s se deja como esta",
                          dominio, entity_id)
            return

    servicio_dominio, servicio = par
    _LOGGER.info("El portero pide %s sobre %s -> %s.%s",
                 "encender" if encender else "apagar", entity_id, servicio_dominio, servicio)
    await hass.services.async_call(
        servicio_dominio, servicio, {"entity_id": entity_id},
        # ⚠️ BLOQUEANTE A PROPOSITO. El portero espera nuestra respuesta HTTP, asi que ejecutar el
        # servicio ANTES de contestar hace que su `200` signifique «hecho» y no «recibido». Es la
        # mejora concreta que MQTT no permitia: con `door_m=1` el portero contestaba `opened` sin
        # tener ni idea, que es el falso exito que §1.8 prohibe en el boton que abre a la calle.
        blocking=True,
    )


async def _manejar(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
    """Un sobre del portero. Devuelve SIEMPRE un cuerpo con la marca -- ver la cabecera."""
    try:
        sobre: dict[str, Any] = await request.json()
    except (ValueError, json.JSONDecodeError):
        # Se contesta con la marca igualmente: el portero necesita saber que **la integracion sigue
        # viva**, que es una pregunta distinta de si este sobre concreto se entendio.
        _LOGGER.warning("Sobre ilegible en %s", webhook_id)
        return web.json_response({WEBHOOK_MARCA: 1, "error": "bad_json"})

    device_id = sobre.get("device_id", "")
    tipo = sobre.get("type")

    if tipo == "action" and sobre.get("ev") == "hass_action":
        d = sobre.get("d") or {}
        entidad = d.get("entity")
        if entidad:
            try:
                await _accionar_entidad(hass, entidad, bool(d.get("on")))
            except Exception:  # noqa: BLE001 - nunca dejar caer el handler: el portero se quedaria
                _LOGGER.exception("No se pudo accionar %s", entidad)
        else:
            _LOGGER.warning("hass_action sin entidad, se ignora")
    else:
        # Un evento de §1.16. Se reparte por el despachador interno y lo recogen las entidades.
        #
        # NO se filtra por `ev` aqui a proposito: un evento que este firmware no conozca todavia
        # debe llegar igual a la entidad de eventos, que es donde el usuario lo vera. Filtrar aqui
        # significaria que una funcion nueva del portero es invisible hasta que se actualice esta
        # integracion, y eso es exactamente lo que hace que una integracion se quede vieja sola.
        async_dispatcher_send(hass, SIGNAL_EVENTO.format(device_id=device_id), sobre)

    return web.json_response({WEBHOOK_MARCA: 1})


async def async_registrar(hass: HomeAssistant, device_id: str, nombre: str) -> str:
    """Registra el webhook de este portero y devuelve su identificador.

    Idempotente: volver a registrar el mismo identificador se ignora sin ruido, que es lo que hace
    falta para que recargar la entrada no rompa nada.
    """
    wid = webhook_id_de(device_id)

    async def _handler(hass_: HomeAssistant, wid_: str, request: web.Request) -> web.Response:
        return await _manejar(hass_, wid_, request)

    try:
        webhook.async_register(
            hass, DOMAIN, f"IG Doorbell {nombre}", wid, _handler,
            allowed_methods=["POST"],
            # Solo desde la propia red. Es lo que compensa que el identificador sea derivable del
            # `device_id`, que es publico -- ver `webhook_id_de`.
            local_only=True,
        )
    except ValueError:
        _LOGGER.debug("El webhook %s ya estaba registrado", wid)
    return wid


def desregistrar(hass: HomeAssistant, device_id: str) -> None:
    """Suelta el webhook. Se llama al descargar la entrada."""
    webhook.async_unregister(hass, webhook_id_de(device_id))
