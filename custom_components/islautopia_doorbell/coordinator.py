"""Le pregunta al portero por su estado, y de ahi viven todas las entidades.

## Por que hay sondeo si el webhook empuja

Porque son dos cosas distintas. El webhook trae **lo que ocurre** -- alguien llamo, hay un paquete,
se abrio la puerta-- y el sondeo trae **como esta** -- en que modo, cuanta gente mira, si hay panel
de calle, que firmware corre. Lo segundo cambia sin que nadie avise: el modo se toca desde el
dashboard del propio portero, el planificador de §1.12-ter lo cambia solo, y un panel aparece en
cuanto alguien enchufa un cable.

Y hace un tercer trabajo que antes hacia el LWT de MQTT: **la disponibilidad**. Si `get_states`
falla, las entidades pasan a no disponibles. Eso sale gratis del sondeo, mientras que con MQTT
habia que configurar un mensaje postumo -- una pieza mas que podia quedarse sin configurar.

## Por que 30 s y no 5

Casi todo lo que cambia deprisa llega empujado. Sondear mas a menudo castigaria al portero para
refrescar cosas que casi nunca se mueven, y `esp_http_server` **atiende de una en una**: una
peticion lenta deja al aparato entero sin contestar a nada mas mientras dura. Ese efecto ya se
midio con el listado de grabaciones, donde un `/api/device_id` de 0,31 s paso a tardar 22.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import api
from .const import DOMAIN, INTERVALO_SONDEO

_LOGGER = logging.getLogger(__name__)


class DoorbellCoordinator(DataUpdateCoordinator[dict]):
    """Un portero. `data` es `get_states` con `firmware_info` mezclado dentro."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        device_id: str,
        credential: str,
        sesion: aiohttp.ClientSession,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{device_id}",
            update_interval=timedelta(seconds=INTERVALO_SONDEO),
            # `config_entry` dejo de ser opcional: sin el, Home Assistant avisa y en las
            # versiones nuevas se niega a construir el coordinador.
            config_entry=entry,
        )
        self.device_id = device_id
        self.credential = credential
        # La sesion de ESTA entrada, con el resolutor que prueba la direccion local antes que
        # el DNS publico (net.py). No la compartida: un resolutor sobre aquella contestaria por
        # todas las integraciones de este Home Assistant.
        self._sesion = sesion
        # `firmware_info` se pide solo de vez en cuando: la version no cambia sola, y pedirla cada
        # 30 s seria una peticion de mas contra un aparato que atiende de una en una. Se refresca
        # tras un OTA porque el portero se reinicia y el sondeo siguiente falla, lo que pone esto a
        # cero. O sea que la actualizacion se nota sin tener que preguntarla a menudo.
        self._ciclos_hasta_firmware = 0
        self._firmware: dict = {}

    @property
    def sesion(self) -> aiohttp.ClientSession:
        """La sesion de este portero, para quien tenga el coordinador y no el hass.data."""
        return self._sesion

    async def _async_update_data(self) -> dict:
        try:
            estado = await api.async_get_states(self._sesion, self.device_id, self.credential)
        except api.AuthenticationError as err:
            # ⚠️ Un 401 sobre una credencial que ANTES funcionaba no es un fallo de red: es que ese
            # portero ya no reconoce a esta integracion -- reinicio a fabrica, revocacion, o la
            # ranura desalojada por antiguedad (§1.5, 16 ranuras, sale la mas vieja). En los tres
            # casos lo unico que se puede hacer es reemparejar, asi que se dice en vez de
            # reintentar en bucle.
            raise UpdateFailed(
                "El portero ya no reconoce esta integracion: hay que volver a emparejarla"
            ) from err
        except api.DoorbellApiError as err:
            raise UpdateFailed(str(err)) from err

        if self._ciclos_hasta_firmware <= 0:
            try:
                self._firmware = await api.async_get_firmware_info(
                    self._sesion, self.device_id, self.credential
                )
                self._ciclos_hasta_firmware = 20     # ~10 minutos
            except api.DoorbellApiError:
                # No es motivo para dejar las entidades sin datos: `get_states` ya respondio, asi
                # que el portero esta vivo. Se reintenta en el ciclo siguiente.
                _LOGGER.debug("No se pudo leer firmware_info; se reintenta", exc_info=True)
        else:
            self._ciclos_hasta_firmware -= 1

        # Se mezclan en un solo diccionario para que las entidades no tengan que saber de cual de
        # las dos rutas sale cada campo. `get_states` manda: si algun dia las dos devolvieran la
        # misma clave, la de estado es la que se refresca cada 30 s.
        return {**self._firmware, **estado}

    # -- ayudas que usan varias entidades ------------------------------------------------------

    @property
    def nombre_portero(self) -> str:
        """`dname`, y si el portero no tiene nombre, su `device_id`.

        Vacio significa «nadie lo ha bautizado», no un nombre (§1.4-ter): machacar con eso lo que
        el cliente ya tenia lo dejaria peor que antes.
        """
        return (self.data or {}).get("dname") or self.device_id

    @property
    def tiene_cerradura(self) -> bool:
        """`door_m=2` es «ninguna» (§1.2).

        Con eso el boton de abrir **no se dibuja** (§1.4-ter). Antes de que `door_m` viajara, un
        cliente solo podia averiguarlo **fallando**: ofrecia el boton, se llevaba un
        `no_lock_configured`, y entonces lo escondia -- asi que el primer usuario de cada sesion
        veia un boton que no funciona, y en un videoportero ese es justo el boton que no puede
        defraudar.
        """
        return (self.data or {}).get("door_m", 2) != 2
