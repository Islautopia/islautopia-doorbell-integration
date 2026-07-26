# islautopia-doorbell-integration — nota de contexto

Repo nuevo (creado 2026-07-09), tercer repo del trío de integración Home Assistant del
ecosistema IG Doorbell, junto a `ig_hassio_addons` (add-on Docker legacy, en proceso de
deprecación para hardware Islautopia — sigue vivo como modo de compatibilidad RTSP/go2rtc
genérico) y `islautopia-intercom-card` (card Lovelace, en rediseño para hablar el protocolo
nativo del doorbell).

**Por qué un repo separado** (decisión del usuario, confirmada 2026-07-09): una integración HACS
("Integration", `custom_components/`) y un add-on de Supervisor (Docker) son mecanismos de
distribución y ciclos de release distintos — no mezclar con `ig_hassio_addons`, que ya tiene
usuarios reales instalados con sus propios tags (`rc0.1`..`rc1.1`).

## Documentos de referencia (no duplicar aquí)

- `C:\Proyectos_espressif\IG_Doorbell\API_CONTRACT.md` — fuente de verdad de la interfaz del
  propio doorbell (WebRTC, señalización, `pair_app`, `app_turn_credentials`, MQTT §4, etc.).
- `C:\Proyectos_espressif\ig_hassio_addons\ig_hassio_addons\ARCHITECTURE.md` — diseño completo de
  los tres repos (integración + card + futuro del addon), decisiones y resoluciones del líder de
  firmware.
- `C:\Proyectos_espressif\ig_hassio_addons\ig_hassio_addons\COORDINATION.md` — preguntas
  abiertas/cerradas con la sesión líder de firmware, formato 🔴/🟡/🟢.

## Estado del código en este repo

`custom_components/islautopia_doorbell/` — implementación completa (manifest, config flow con
Zeroconf + entrada manual, despachador MQTT de `videoportero/door/action`, puente WebSocket para
la card, cliente HTTP mínimo para pairing/TURN). Ya verificada de extremo a extremo contra
hardware/HA reales (emparejamiento, dispositivo fusionado con entidades, vídeo en vivo en la
card embebida) — ver `COORDINATION.md` para el historial completo.

**No hay ningún `discovery.py`** — existió brevemente y se eliminó por completo el 2026-07-10
(ver landmina más abajo). No lo vuelvas a crear para "resolver la IP local del doorbell" sin leer
esa nota primero.

**`__init__.py::async_setup_entry` registra un Device en el device registry de HA** (sin entidades
propias, ver docstring del módulo) con `identifiers={(DOMAIN, device_id)}` — no es decorativo:
existe específicamente para que el picker nativo `ha-selector` (`selector: {device: {filter:
{integration: 'islautopia_doorbell'}}}`) que usa el editor de `islautopia-intercom-card` pueda
listar los doorbells emparejados por nombre, sin que el usuario tenga que copiar/pegar ningún
`device_id` a mano. Si se renombra el `DOMAIN` o se cambia cómo se construyen los `identifiers`,
hay que actualizar el editor de la card en el mismo cambio (usa el mismo par
`["islautopia_doorbell", "<device_id>"]` para traducir en ambas direcciones).

## Landmina real encontrada en pruebas con hardware/HA reales (2026-07-09) — NO la repitas

`async_get_or_create()` DEBE registrar el device con **DOS** identifiers, no solo el propio: el
nuestro (`(DOMAIN, device_id)`) Y el que usa la MQTT discovery del propio firmware
(`("mqtt", f"ig_doorbell_{device_id}")`, ver `main/networktask.c` línea ~121 en IG_Doorbell:
`"dev":{"ids":["ig_doorbell_<dev_id>"],...}`). Sin el segundo, HA crea DOS dispositivos separados
— el nuestro (vacío, sin entidades, parece roto) y uno aparte con las entidades reales de MQTT
discovery (modo/timbre/puerta/persona/abrir), sin ninguna relación entre ambos. Confirmado en
real: usuario emparejó, HA no mostró ningún error en Registros, y aun así "este dispositivo no
tiene entidades" — el fallo era silencioso, no una excepción. Ver `COORDINATION.md` Q11 para el
diagnóstico completo. Si algún día cambia el prefijo `ig_doorbell_` o el identifier de la MQTT
discovery en el firmware, hay que actualizar `mqtt_ident` en `__init__.py` en el mismo cambio.

## Segunda landmina real, misma familia que la anterior (2026-07-09) — NO la repitas

`async_get_or_create()` NUNCA debe pasar `name=` explícito para este device fusionado. Verificado
contra el código fuente real de `device_registry.py` de HA Core (no asumido): pasar `name=` en
cada llamada SIEMPRE sobrescribe el nombre guardado del dispositivo, incluso si otra integración
(en este caso `mqtt`, con el `device_name` real del propio doorbell) ya le había puesto un nombre
mejor — "quien llame último, gana". Con el device fusionado (landmina de arriba), cada
arranque/recarga NUESTRO competía con la MQTT discovery por el nombre mostrado, y el nuestro
(`entry.title`, solo un hint — nombre de mDNS o el `device_id` en crudo) a veces ganaba,
mostrando algo feo tipo "IG Doorbell v2" en vez del nombre real que el usuario configuró en el
doorbell. Omitir `name` es seguro: si el device es nuevo, HA le pone el título del config entry
por defecto igualmente (mismo resultado que antes en el peor caso); si ya existe, nuestra llamada
ya no lo toca nunca más — solo el `mqtt` integration (dueño real del `device_name`) lo actualiza.
Ver `COORDINATION.md` Q13. Si alguna vez se necesita mostrar un nombre desde esta integración
(p. ej. si se añaden entidades propias en el futuro), usar `default_name=`, NO `name=` — ese
parámetro solo se aplica si el device no tiene nombre todavía, sin pisar el de MQTT.

## Tercera landmina — NO reintroduzcas resolución mDNS de `local_host` (2026-07-10)

Hubo un `discovery.py` (módulo de mDNS server-side, con caché y browse en background) que
resolvía la IP local del doorbell para devolverla como `local_host` en `get_connection_info`.
**Se eliminó por completo, a propósito, no fue un descuido**: (1) confirmado con grep en los tres
repos que ningún consumidor real lo usaba — la card siempre conecta por el hostname público
(`<device_id>.doorbell.islautopia.com:8443`), nunca por IP, tanto por el certificado TLS (atado
al hostname) como por CORS/mixed-content; y (2) **mDNS es multicast y normalmente no cruza
límites de VLAN/subred** sin un relay explícito — para cualquier instalación con segmentación de
red real (redes domésticas avanzadas con VLANs, un caso legítimo y real, no un edge case raro),
confiar en mDNS para esto habría sido activamente incorrecto para doorbells aprovisionados
manualmente por IP en una VLAN distinta a la de HA, no solo código sin usar. Además, la
resolución en caliente costaba hasta 4 segundos bloqueando cada arranque de sesión de la card
antes de arreglarse a no-bloqueante (ver `COORDINATION.md` Q15) — un coste real por un dato que
ni siquiera debía estar ahí.

`CONF_HOST_HINT` (el hint de IP capturado en `config_flow.py` al emparejar, manual o vía
Zeroconf) se mantiene — barato, sin coste en tiempo de ejecución, sin consumidor activo hoy pero
podría servir para diagnóstico/soporte manual en el futuro. El descubrimiento de emparejamiento
por Zeroconf (`config_flow.py::async_step_zeroconf`) tampoco se toca — es opcional/oportunista,
con la entrada manual por IP siempre disponible como alternativa real, así que no comparte el
mismo problema. Detalle completo en `COORDINATION.md` Q16.

## Práctica estándar — subir `version` en `manifest.json` en CADA cambio (2026-07-10)

Aviso del usuario, aplica a partir de ahora, sin excepción: **cada vez que se modifique cualquier
fichero de `custom_components/islautopia_doorbell/`, hay que subir el campo `"version"` de
`manifest.json` en el mismo cambio** — mismo principio ya aplicado en el `config.json` del addon
`islautopia_ha_https` (`ig_hassio_addons`). Motivo: HACS/HA usan ese número para decidir si hay
algo nuevo que instalar/actualizar — sin subirlo, pueden no detectar una actualización real aunque
el código en disco sea distinto, especialmente relevante el día que esto se distribuya de verdad
vía HACS en vez de la copia manual por SMB que usamos ahora durante el desarrollo.

Historial: `0.1.0` → `0.2.0` el 2026-07-10, acumulando todo lo hecho desde la primera
implementación hasta este punto (fusión de identifiers Q11, no pisar `name=` Q13, eliminación de
`discovery.py`/mDNS Q15-Q16, fix del bloque de diagnóstico Q17) — no se había subido la versión en
ninguno de esos cambios individuales porque hasta ahora el despliegue era copia directa + reinicio
completo (que sí relee todo desde disco sin depender del número de versión) — a partir de ahora,
subirla en cada cambio de todas formas, como hábito, no solo cuando haga falta para forzar una
detección de actualización. `0.2.0` → `0.3.0` el 2026-07-11 (fix de `mqtt_dispatch.py`, ver abajo).

## Bug real CORREGIDO (2026-07-11): `mqtt_dispatch.py` descartaba el nuevo `action:"close"` del firmware — "la luz se enciende pero nunca se apaga sola"

El líder de firmware corrigió un bug real en `main/hardtask.c::open_door()` (rama
`feature-device-auth-provisioning`): en modo `door_m=1` (Home Assistant), el dispositivo solo
publicaba `{"action":"open","entity_id":"..."}` en `videoportero/door/action` y nunca un cierre
simétrico tras `dur` segundos — a diferencia del relé físico (`door_m=0`), que sí lo respeta desde
siempre. Ahora publica también `{"action":"close","entity_id":"<mismo ha_e>"}`
`open_duration_s` segundos después, verificado en real por el líder con una captura MQTT en vivo
(el "close" sale exactamente `dur + 0.001s` después del "open", de forma consistente).

**El hueco real en este repo**: `_async_dispatch()` en `mqtt_dispatch.py` tenía
`if not isinstance(payload, dict) or payload.get("action") != "open": ... return` —
CUALQUIER `action` que no fuera literalmente `"open"` se descartaba (log a DEBUG). El "close"
nuevo caía justo ahí, sin disparar nada. Confirmado en real por el líder con `light.faro` (vía
zigbee2mqtt) como `ha_e` de prueba: el "open" sí disparaba `light.turn_on` correctamente, pero el
"close" tres segundos después no producía ningún efecto — la luz se quedaba encendida para
siempre. Exactamente el síntoma que reportó un usuario real.

**Corregido**, siguiendo la propuesta del propio líder (revisada y aplicada tal cual, con
verificación de sintaxis + simulación aislada de la tabla de resolución, ver más abajo):

- `const.py`: nueva tabla `DOMAIN_CLOSE_SERVICE`, paralela a `DOMAIN_OPEN_SERVICE` —
  `lock`→`lock.lock`, `cover`→`cover.close_cover`, `light`→`light.turn_off`,
  `switch`→`switch.turn_off`, `input_boolean`→`input_boolean.turn_off`. **Deliberadamente sin**
  `button`/`scene`/`script` (ninguno tiene un "cierre" con sentido real — un botón no se
  "despulsa", una escena/script es una acción de un solo disparo sin estado opuesto definido) —
  meterlos con un fallback inventado sería peor que no hacer nada.
- `mqtt_dispatch.py`: `_async_dispatch()` ahora ramifica por `action in ("open", "close")` en vez
  de descartar cualquier cosa que no sea `"open"`. Para `"close"` en un dominio sin mapeo (button/
  scene/script), sale sin efecto con un log a DEBUG — a propósito SIN el warning ruidoso que sí
  tiene sentido para "open" (ahí un dominio sin mapeo es un hueco real a rellenar; para "close" en
  esos tres dominios es una propiedad legítima del dominio, no un hueco).

Verificado con `python -m py_compile` (no hay `homeassistant` instalable en este entorno, mismo
límite que el resto de esta sesión) + una simulación aislada en Python de la tabla de resolución
open/close para los 8 dominios relevantes (incluyendo un dominio desconocido) — confirmado que
cada combinación resuelve exactamente al servicio esperado, y que button/scene/script devuelven
"sin acción" para close sin lanzar nada. **No probado contra hardware/HA reales en esta sesión**
— pendiente de que el líder repita su captura MQTT en vivo con la integración actualizada
desplegada (tiene el harness listo, confirmó que tarda un minuto). Ver `COORDINATION.md` Q25.

## Decisión razonada (2026-07-26): NO se exponen entidades de "clientes conectados" ni "turno de palabra" — y por qué

Con el contrato de multicliente (`API_CONTRACT.md` §1.4-ter: turno de palabra, contador de
clientes WebRTC y calidad por destinatario) se valoró exponer en HA, como sensores de esta
integración, **cuántos clientes hay conectados** y **quién tiene el turno de palabra**, para que
el usuario pudiera automatizar sobre ello. **Decisión: no, y no por pereza — no hay ningún camino
correcto para obtener ese dato desde aquí.** Los tres candidatos, y por qué se descartan:

1. **Sondear `GET /api/get_states` (que sí trae `webrtc_clients`, §1.2).** Imposible con lo que
   esta integración tiene. Verificado en el firmware real (`main/webtask.c::get_states_handler`
   llama a `auth_require()`, y `main/auth.c` solo acepta **cookie de sesión**): esa ruta exige
   una sesión de usuario del doorbell. La única credencial que la integración guarda es la de
   `pair_app`, que el firmware acepta **solo** en `/webrtc/signal` y `/webrtc/signal/post`
   (§1.4) — nunca en `/api/*`. Conseguirlo exigiría guardar el email+contraseña de administrador
   del doorbell dentro de Home Assistant, que es exactamente lo que todo el diseño de
   emparejamiento existe para evitar (ver §1.5: la app/card nunca ve credenciales de admin). Un
   contador de espectadores no justifica ni de lejos esa regresión de seguridad.

2. **Mantener una conexión WS permanente al relay desde la integración y escuchar `session_info`.**
   No funciona, y además se estropearía a sí mismo. `session_info` se emite **por sesión WebRTC
   viva** (`broadcast_session_info()` recorre `g_sessions[]` y solo escribe en las que están
   `in_use`): un cliente conectado al relay que nunca manda `request_offer` no tiene slot y no
   recibe nada. Para recibirlo habría que abrir una sesión WebRTC de verdad… que **incrementaría
   el propio contador que se quiere medir** (efecto observador) y ocuparía permanentemente 1 de
   los 4 slots (`MAX_WEBRTC_SESSIONS=4`), dejando al usuario con 3. Descartado sin más análisis.

3. **MQTT.** El firmware ya publica autodiscovery de HA (`main/networktask.c`) con sus entidades
   de modo/timbre/puerta/presencia, y desde 2026-07-09 lo re-publica en cada evento real. Añadir
   ahí un `webrtc_clients` costaría casi nada, no necesitaría ninguna conexión nueva, no tendría
   efecto observador y le daría al usuario una entidad con histórico de verdad. **Es el sitio
   correcto para esto — pero es un cambio de FIRMWARE, no de esta integración.** Queda propuesto
   al equipo de firmware, no implementado aquí.

Sobre **el turno de palabra como entidad**, la respuesta es no en cualquier caso, incluso por
MQTT: el dato del contrato es un **número de slot** (`talker`), que fuera del canal de
señalización no significa nada para nadie (no identifica a una persona ni a un dispositivo — el
slot 2 de hoy es otro visitante mañana), y es un estado **efímero de segundos** que ensuciaría el
recorder de HA con transiciones sin valor. Si algún día se quiere automatizar sobre esto, lo
útil es un booleano *"hay una conversación en curso con la puerta"*, no *"quién"* — y ese es un
concepto distinto que habría que definir a propósito, no un subproducto del arbitraje interno.

**Consecuencia práctica: esta integración NO necesitó ningún cambio de código para el contrato de
multicliente.** La card obtiene el contador y el turno por el canal de señalización, directa del
dispositivo, que es donde ese dato vive de verdad. `manifest.json` no sube de versión por este
cambio: no se ha tocado ningún fichero de `custom_components/` (la regla de subir la versión
aplica a cambios de código, y aquí solo se documenta una decisión).

## No hacer commit/push sin autorización explícita

Mismo protocolo que el resto del equipo.
