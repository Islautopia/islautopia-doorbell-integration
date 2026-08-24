"""Reach the doorbell on the LAN first, and fall back to public DNS.

## The defect this exists to close

Every call in `api.py` targets `<device_id>.doorbell.islautopia.com`, which is a **public** name.
Home Assistant resolves it through public DNS, so with the internet down the coordinator's poll
fails, every entity goes `unavailable`, and **the button that opens the front door stops working**
-- on a machine sitting on the same switch as the doorbell. That is exactly what principle 1 of
API_CONTRACT.md exists to prevent, and §0-bis names this hostname as the known way to violate it.

## What it does, and what it deliberately does NOT do

The contract is explicit about the shape of the fix (§0, and the iOS app is the reference): connect
to the IP and **validate the certificate against the expected hostname**, never relax the hostname
check. That is easy to get backwards -- from the outside it looks like iOS skips verification, when
it does the opposite: it keeps it and picks by hand what to verify against.

So the URLs keep the public hostname, untouched. Only *where the connection goes* changes:

    url          https://<device_id>.doorbell.islautopia.com:8443/...   <- unchanged, so SNI and
                                                                          certificate validation
                                                                          are unchanged too
    connects to  192.168.x.y                                            <- this resolver

`api.py` needs no edits at all, and there is no way for this to silently become "trust anything":
the certificate still has to be a real one for that name.

## Why the resolver returns BOTH addresses instead of choosing

`resolve()` hands back the LAN address first and then whatever DNS says. aiohttp walks that list in
order and moves to the next entry when a connection fails, so the fallback is the transport's, not
ours -- there is no "is the LAN reachable?" check to get wrong, and no state to go stale.

That matters because the hint CAN go stale: DHCP moves the doorbell and the stored address now
belongs to someone else, or to nobody. With one address we would have to detect that; with two,
a refused connection just falls through to DNS, and with no internet either it fails, correctly.

⚠️ **A stale hint pointing at a live machine that is not the doorbell is the one case this does not
catch by itself** -- and TLS does: that machine has no certificate for the doorbell's name, the
handshake fails, and the attempt moves on. Nothing is trusted that should not be.

## The cost of getting it wrong, measured

Falling back is free when the stale address REFUSES the connection: the kernel answers at once and
the next address is tried immediately. It is not free when the address is a **black hole** -- there
is nothing to refuse, so the attempt runs to its timeout before anything else is tried.

Measured on 2026-08-24 by deliberately pointing the hint at 192.0.2.1 (TEST-NET-1, which nothing
can answer): the entry did not merely poll slowly, **it failed to set up at all** -- Home Assistant
gives an entry a bounded budget and every request inside it was spending the full connect timeout.
The failure was clean and loud rather than silent, which is the right way round, but it is worth
knowing before blaming the doorbell: `Timeout fetching ... data` plus `Error setting up entry` with
a reachable doorbell means the stored address is pointing somewhere nothing lives.

That same measurement is what proves this file is in the loop at all. Nothing in Home Assistant
reads `host_hint` at run time except this resolver, so a change confined to it that visibly changed
the failure mode -- an immediate refusal naming the LAN address became a timeout -- cannot have
come from anywhere else. The same test aimed at the real address proves nothing: public DNS returns
that very address, so the resolver and plain DNS are indistinguishable there.
"""
from __future__ import annotations

import asyncio
import logging
import socket
from ipaddress import ip_address

import aiohttp
from aiohttp.abc import AbstractResolver

from homeassistant.core import HomeAssistant
from homeassistant.util.ssl import client_context

_LOGGER = logging.getLogger(__name__)


class LanFirstResolver(AbstractResolver):
    """Resolve known doorbell hostnames to their LAN address first, then ask DNS."""

    def __init__(self, mapeo: dict[str, str]) -> None:
        # Read once and kept: a new address arrives as a config-entry update, which reloads the
        # integration, which closes this session and builds another. Nothing mutates this map in
        # place, so there is no live state here to get out of step with the entry.
        self._mapeo = mapeo
        # ThreadedResolver rather than AsyncResolver: it is always present, while AsyncResolver
        # needs aiodns. This resolves a handful of names a minute, so the difference is not
        # measurable here -- and a hard dependency that fails at import time would take the whole
        # integration down for a lookup that is a fallback in the first place.
        self._dns = aiohttp.ThreadedResolver()

    async def resolve(
        self, host: str, port: int = 0, family: int = socket.AF_INET
    ) -> list[dict]:
        salidas: list[dict] = []

        lan = self._mapeo.get(host)
        if lan:
            salidas.append(
                {
                    "hostname": host,
                    "host": lan,
                    "port": port,
                    "family": socket.AF_INET,
                    "proto": 0,
                    "flags": 0,
                }
            )

        try:
            salidas.extend(await self._dns.resolve(host, port, family))
        except OSError:
            # No internet is the case this whole module is for: if we have a LAN address, that is
            # not an error, it is the point. Only re-raise when there is nothing left to try.
            if not salidas:
                raise
            _LOGGER.debug("DNS no resuelve %s; queda la direccion local %s", host, lan)

        return salidas

    async def close(self) -> None:
        await self._dns.close()


def crear_sesion(hass: HomeAssistant, mapeo: dict[str, str]) -> aiohttp.ClientSession:
    """A session for one doorbell, with the LAN-first resolver on it.

    ⚠️ NOT `async_get_clientsession(hass)`: that one is shared with every other integration, so a
    resolver on it would answer for the whole of Home Assistant. This one is per config entry and
    **must be closed in `async_unload_entry`** -- it is not registered for automatic cleanup,
    because auto-cleanup fires on Home Assistant stop and an integration can be unloaded and
    reloaded many times before that.
    """
    conector = aiohttp.TCPConnector(
        resolver=LanFirstResolver(mapeo),
        # Home Assistant's own context, and for two reasons rather than style. It is built once at
        # startup, so it is not loading the CA bundle from disk inside the event loop the first
        # time somebody opens the door; and it is the same verification every other integration
        # gets, so this file cannot become the place where the rules are quietly different.
        #
        # Verification is FULL, and that is the whole point: the URL still carries the public
        # hostname, so the doorbell has to present a real certificate for it. Connecting by IP
        # without this would be relaxing exactly what API_CONTRACT.md §0 says never to relax.
        ssl=client_context(),
    )
    return aiohttp.ClientSession(connector=conector)


async def averiguar_local(
    sesion: aiohttp.ClientSession, device_id: str, candidatas: list[str]
) -> tuple[str | None, str | None]:
    """Cual de estas direcciones es de verdad este portero, ahora mismo.

    ## Por que hace falta, medido en la calle el 2026-08-24

    El portero cambio de VLAN al instalarse -- de 192.168.41.173 a 192.168.33.173, que es su red
    definitiva-- y la direccion guardada dejo de ser suya. Peor: no quedo REHUSANDO, quedo como un
    **agujero negro**, y eso son 10,01 s medidos por intento antes de caer al DNS. O sea que la
    direccion obsoleta no es solo inutil: es un lastre en cada peticion, y con el presupuesto de
    arranque de una entrada por medio puede impedir que la integracion cargue.

    Y no es un caso raro que valga la pena ignorar: §0-bis dice que **mDNS no cruza VLANs**, y que
    un portero en su propia VLAN es el despliegue previsto. O sea que el descubrimiento automatico
    no va a encontrarlo NUNCA, sin dar ningun error -- devuelve una lista vacia, indistinguible de
    "no hay ningun portero".

    ## Como se comprueba, y por que ESTA ruta

    `GET /api/device_id`, HTTP plano en el puerto 80, sin credenciales. El contrato la define en §0
    exactamente para esto: el primer contacto, antes de tener nada. Es de solo lectura y no tiene
    ningun efecto lateral, asi que sondear con ella no toca el timbre ni la puerta ni el reloj --
    que es la razon por la que en este proyecto no se barre con GET a lo que sea.

    ⚠️ **Y se comprueba que el device_id COINCIDE, no que algo conteste.** Una direccion reciclada
    por DHCP puede tener detras otro aparato, y hasta otro portero: sin esa comparacion, "hay algo
    ahi" y "es el mio" dan la misma respuesta, y la segunda es la unica que autoriza a guardarla.

    ## Una candidata puede ser un NOMBRE, y se devuelve su direccion igualmente

    La ultima candidata es el hostname publico. Sirve de puente: con internet, preguntarle a el
    ensena cual es la direccion buena AHORA, y lo que se guarda es esa direccion -- no el nombre.
    Asi un corte posterior encuentra el numero ya aprendido, en vez de descubrir que el unico sitio
    donde estaba escrito era un DNS que ya no contesta.

    ⚠️ La primera version leia esa direccion del `peername` de la conexion, y **devolvia None**: al
    llegar ahi la respuesta ya se habia soltado al pool. No fallaba -- guardaba el NOMBRE como si
    fuera una direccion, que es peor, porque el mapeo quedaba apuntando un nombre a si mismo y todo
    seguia funcionando por DNS como si el arreglo estuviera puesto. Ahora se resuelve a proposito.

    ## Devuelve DOS cosas, y la segunda es la que hace diagnosticable esto

    `(direccion, quien_contesto)`. Con las dos se pueden separar tres situaciones que de otro modo
    salen por el mismo sitio y se leen igual:

        (None, None)      nadie contesto     -> el portero esta apagado o no se alcanza. Normal.
        (None, "nombre")  contesto y no pude -> ANOMALIA: es un fallo nuestro, y hay que gritarlo
        ("1.2.3.4", ...)  bien

    La primera version devolvia solo la direccion, asi que los dos primeros casos eran el mismo
    `None` -- y el segundo se paso por debajo sin que nadie lo viera: guardo el nombre en vez de la
    direccion, todo siguio funcionando por DNS, y el arreglo parecia puesto sin estarlo.
    """
    for ip in candidatas:
        if not ip:
            continue
        try:
            async with sesion.get(
                f"http://{ip}/api/device_id",
                # Corto a proposito: esto corre en el arranque de la entrada y una candidata mala
                # es justo la que se va a comer el plazo entero. Un portero en la misma red
                # contesta en decenas de milisegundos.
                timeout=aiohttp.ClientTimeout(total=2),
            ) as resp:
                if resp.status != 200:
                    continue
                datos = await resp.json(content_type=None)
        except (aiohttp.ClientError, OSError, TimeoutError, ValueError):
            continue

        if not isinstance(datos, dict) or datos.get("device_id") != device_id:
            continue

        try:
            ip_address(ip)
            return ip, ip
        except ValueError:
            pass

        # Era un nombre y ha contestado: se resuelve a una direccion, que es lo unico que sirve
        # para guardar. `getaddrinfo` del bucle no bloquea; una consulta que falle aqui no es
        # grave -- significa que hay que seguir tirando de DNS, o sea lo de siempre.
        try:
            info = await asyncio.get_running_loop().getaddrinfo(
                ip, 80, family=socket.AF_INET, type=socket.SOCK_STREAM
            )
        except OSError:
            return None, ip
        if info:
            return info[0][4][0], ip
        return None, ip
    return None, None
