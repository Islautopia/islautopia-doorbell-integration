# Islautopia Doorbell — integración nativa para Home Assistant

Integración de Home Assistant (HACS, categoría "Integration") para el **IG Doorbell**
(videoportero comercial ESP32-P4 de Islautopia Garage) — WebRTC nativo, HTTPS real, relay/TURN
propio, sin pasar por RTSP ni por `go2rtc`.

> Si buscas soporte para un intercomunicador RTSP genérico de terceros (no un IG Doorbell), esa
> es la [Islautopia Intercom Engine](https://github.com/Islautopia/ig_hassio_addons) — un add-on
> Docker distinto, con un rol distinto. Este repo es la vía recomendada específicamente para
> hardware Islautopia.

## Qué hace

1. **Despacha `videoportero/door/action` automáticamente** — cuando el propio doorbell está en
   "modo Home Assistant" (`door_mode=1`) y alguien abre la puerta, publica un mensaje MQTT con la
   entidad a accionar. Sin esta integración, ese mensaje no hace nada por sí solo (MQTT es
   pub/sub puro) y había que escribir una Automatización a mano. Con la integración instalada,
   cero configuración adicional: se detecta el dominio de la entidad (`light`/`switch`/`lock`/
   `cover`/...) y se llama al servicio correcto automáticamente.
2. **Empareja el doorbell una vez** (flujo de configuración de HA, sin YAML) y guarda solo la
   credencial de acceso remoto de 64 caracteres hex — nunca la contraseña de administrador.
3. **Sirve de "credential broker" para la [Islautopia Intercom
   Card](https://github.com/Islautopia/islautopia-intercom-card)**: resuelve el host local del
   doorbell por mDNS (los navegadores no pueden hacerlo por sí mismos) y entrega credenciales TURN
   efímeras bajo demanda — la card nunca necesita que le pegues nada a mano.

## Qué NO hace (a propósito)

No mantiene sesión administrativa persistente contra el doorbell, no hace polling de su API
REST local, y no actúa de proxy de medios — el vídeo/audio va directo entre el navegador y el
doorbell (o el relay). Ver `ARCHITECTURE.md` en
[`ig_hassio_addons`](https://github.com/Islautopia/ig_hassio_addons) para el diseño completo y el
porqué de este alcance.

## Instalación

### Vía HACS (recomendado)
1. HACS → menú (⋮) → **Repositorios personalizados** → añade la URL de este repo, categoría
   **Integración**.
2. Busca "Islautopia Doorbell" → **Descargar**.
3. Reinicia Home Assistant.
4. **Ajustes → Dispositivos y servicios → Añadir integración** → "Islautopia Doorbell" (o espera
   a que aparezca solo en "Descubierto" si tu doorbell ya está en la misma red).

### Manual
Copia `custom_components/islautopia_doorbell/` a `<config>/custom_components/` y reinicia HA.

## Requisitos

- La integración `mqtt` de Home Assistant ya configurada (Mosquitto u otro broker) — el mismo
  broker al que apunta el propio doorbell (`mqtt_broker` en su configuración, sección Red).
- El doorbell ya aprovisionado (WiFi/Ethernet + usuario administrador creado, vía la app o el
  portal de configuración) antes de emparejarlo aquí.

## Estado

Implementación inicial (config flow + despachador MQTT + puente WebSocket para la card),
validada por diseño con el equipo de firmware — pendiente de verificación end-to-end contra una
instancia real de Home Assistant. Ver `custom_components/islautopia_doorbell/discovery.py` para
la nota sobre qué parte de la resolución mDNS es más sensible a la versión concreta de HA Core.

---
*Desarrollado por Islautopia Garage.*
