"""One command over the doorbell's signalling channel, the same one the apps use.

## Why the signalling channel and not a new HTTP route (Iñaki, 2026-09-25)

"Why add HTTP routes? We already have the routes the apps use. Why do it differently for HASS?"
Quick replies (`play_audio`), sequences (`play_sequence`) and REC (`rec_start`/`rec_stop`) are
signalling messages (§3.3, §1.4-quater). Home Assistant sends them the same way an app does: open
the local SSE (`/webrtc/signal`), take the `slot` from the `offer`, POST the message with that
slot, read the answer, say `bye`.

## What that costs the doorbell, MEASURED on the Waveshare (0.100.0, 2026-09-25)

- An SSE that never answers the offer takes a **signalling** slot (`sig_used` 1 of 8) and **no
  viewer slot** (`view_used` 0 of 4, `viewers` 0): no video is encoded for it.
- `play_audio` and `play_sequence` are answered on such a session (`play_audio_result`,
  `play_sequence_result`) — no WebRTC answer, ICE or media needed, as §3.3 says for `open`.
- `rec_start` also works, but **a manual recording ends when the session that pressed REC ends**
  (§1.4-quater rule 4; measured: `recording:false` right after the `bye`). So REC cannot be a
  one-shot command: it needs a session held for the whole recording. Not implemented here.

Every command closes its session with `bye` in a `finally`, so a slot is never left to the
doorbell's 20 s abandonment timer.
"""
from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import quote

import aiohttp

from . import api

_LOGGER = logging.getLogger(__name__)

_SSE_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=8, sock_read=15)
_POST_TIMEOUT = aiohttp.ClientTimeout(total=8)


class SignalError(api.DoorbellApiError):
    """The doorbell refused the command or did not answer it."""


async def async_orden(
    sesion: aiohttp.ClientSession,
    device_id: str,
    credential: str,
    mensaje: dict,
    respuesta: str,
    *,
    plazo: float = 8.0,
) -> dict:
    """Send `mensaje` on a fresh signalling session and return the doorbell's `respuesta` message."""
    base = f"https://{api.doorbell_hostname(device_id)}:8443"
    token = quote(credential)
    slot: int | None = None

    async def _post(msg: dict) -> None:
        async with sesion.post(
            f"{base}/webrtc/signal/post?token={token}",
            data=json.dumps(msg),
            headers={"Content-Type": "application/json"},
            timeout=_POST_TIMEOUT,
        ) as r:
            if r.status == 401:
                raise api.AuthenticationError("Pairing credential rejected by the doorbell")
            if r.status != 200:
                raise SignalError(f"signal POST -> HTTP {r.status}")

    try:
        resp = await sesion.get(f"{base}/webrtc/signal?token={token}", timeout=_SSE_TIMEOUT)
    except (aiohttp.ClientError, OSError, TimeoutError) as err:
        raise api.DoorbellApiError(f"Could not reach the doorbell: {err}") from err
    try:
        if resp.status == 401:
            raise api.AuthenticationError("Pairing credential rejected by the doorbell")
        if resp.status != 200:
            raise SignalError(f"signal SSE -> HTTP {resp.status}")

        async def _leer() -> dict:
            nonlocal slot
            enviado = False
            async for linea in resp.content:
                linea = linea.strip()
                if not linea.startswith(b"data:"):
                    continue
                try:
                    msg = json.loads(linea[5:])
                except ValueError:
                    continue
                tipo = msg.get("type")
                if tipo == "error" and msg.get("reason") == "sessions_full":
                    raise SignalError("sessions_full")
                if tipo == "offer" and slot is None and isinstance(msg.get("slot"), int):
                    slot = msg["slot"]
                    await _post({**mensaje, "slot": slot})
                    enviado = True
                elif enviado and tipo == respuesta:
                    return msg
            raise SignalError("the doorbell closed the signalling session")

        try:
            return await asyncio.wait_for(_leer(), plazo)
        except TimeoutError as err:
            raise SignalError(f"no {respuesta} within {plazo:.0f} s") from err
    finally:
        if slot is not None:
            try:
                await _post({"type": "bye", "slot": slot})
            except Exception:  # noqa: BLE001 - best effort; the doorbell reaps it at 20 s anyway
                _LOGGER.debug("bye after %s failed", mensaje.get("type"), exc_info=True)
        resp.close()
