"""Holds the doorbell's manual-recording (REC) signalling session open for as long as the
recording lasts, so a manual recording started from Home Assistant does not stop the moment the
integration's own session ends.

## Why this exists, and why signal_client.py's `async_orden` is not enough (Iñaki, 2026-09-25)

Quick replies and sequences (signal_client.py) are one-shot: open the local SSE, take the `slot`
from the `offer`, POST the message, read the reply, say `bye` - done in under a second.

REC is not one-shot. Measured on the Waveshare (fw 0.100.0, 2026-09-25) and written into
API_CONTRACT.md §1.4-quater rule 4: **a manual recording started with `rec_start` stops the
moment the session that pressed it ends.** `async_orden` says `bye` in its `finally` right after
the first reply, so a REC fired that way recorded for a fraction of a second and stopped. Iñaki's
call: keep the session open for as long as the recording should run, not add a firmware route.

## What this owns

- Opens the SSE, sends `rec_start` on the first `offer`, and then keeps reading - the SSE and its
  slot stay held by this object, not by whoever called `start()`.
- Turns every pushed `rec_state` (API_CONTRACT §1.4-quater) into `self.recording`/`kind`/`origin`/
  `sd_available` and calls `on_update()` so a Home Assistant entity can mirror the doorbell's OWN
  state - never a locally-guessed "a session is held so it must be recording".
- Closes itself (rec_stop if still recording, then bye, then the SSE) the moment the doorbell
  says `recording:false` on its own - the 10-minute cap, an admin stopping it from another
  session, a ring taking the slot for a call. Nothing here waits for someone to notice and flip a
  switch off: an unrecognised owner is exactly how a slot leaks.
- `stop()` is the other half, for when it IS the user turning the switch off, and for
  unload/reload (see switch.py) - unpaired with a `start()` it is a no-op, and called twice it is
  a no-op the second time (`closed`), so an entity can call it defensively without checking state
  first.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from urllib.parse import quote

import aiohttp

from . import api

_LOGGER = logging.getLogger(__name__)

# `sock_read=None`: unlike a one-shot command (signal_client.py), this stream is expected to sit
# idle for minutes between `rec_state` pushes - a finite read timeout would tear down a perfectly
# healthy held session.
_SSE_TIMEOUT = aiohttp.ClientTimeout(total=None, connect=8, sock_read=None)
_POST_TIMEOUT = aiohttp.ClientTimeout(total=8)

# The doorbell's own refusal reasons (§1.4-quater), same spirit as services.py's `_ERRORES`.
_ERRORES = {
    "admin_required": "This pairing is not an administrator of the doorbell.",
    "no_sd": "The doorbell has no usable SD card right now.",
    "busy": "The doorbell is already recording something else.",
}


class RecSessionError(api.DoorbellApiError):
    """`rec_start` was refused, or the held signalling session could not be kept alive."""


class RecSession:
    """One held signalling session, from `rec_start` to `rec_stop` + `bye`."""

    def __init__(
        self,
        sesion: aiohttp.ClientSession,
        device_id: str,
        credential: str,
        on_update: Callable[[], None],
    ) -> None:
        self._sesion = sesion
        self._device_id = device_id
        self._credential = credential
        self._on_update = on_update
        self._resp: aiohttp.ClientResponse | None = None
        self._task: asyncio.Task | None = None
        self._slot: int | None = None
        self.recording = False
        self.kind: str | None = None
        self.origin: str | None = None
        self.sd_available: bool | None = None
        self.closed = False

    async def start(self, *, plazo: float = 8.0) -> None:
        """Opens the session and sends `rec_start`; returns once the first `rec_state` (or a
        refusal) arrives. The background reader keeps running after this returns - that is what
        keeps the slot and lets a LATER `rec_state:false` close things down on its own.
        """
        base = f"https://{api.doorbell_hostname(self._device_id)}:8443"
        token = quote(self._credential)
        try:
            self._resp = await self._sesion.get(
                f"{base}/webrtc/signal?token={token}", timeout=_SSE_TIMEOUT
            )
        except (aiohttp.ClientError, OSError, TimeoutError) as err:
            raise api.DoorbellApiError(f"Could not reach the doorbell: {err}") from err
        if self._resp.status == 401:
            raise api.AuthenticationError("Pairing credential rejected by the doorbell")
        if self._resp.status != 200:
            raise RecSessionError(f"signal SSE -> HTTP {self._resp.status}")

        primero: asyncio.Future = asyncio.get_running_loop().create_future()
        self._task = asyncio.create_task(self._leer(primero))
        try:
            await asyncio.wait_for(asyncio.shield(primero), plazo)
        except TimeoutError as err:
            await self.stop()
            raise RecSessionError(f"no rec_state within {plazo:.0f} s") from err
        except Exception:
            await self.stop()
            raise

    async def _post(self, msg: dict) -> None:
        base = f"https://{api.doorbell_hostname(self._device_id)}:8443"
        token = quote(self._credential)
        async with self._sesion.post(
            f"{base}/webrtc/signal/post?token={token}",
            data=json.dumps(msg),
            headers={"Content-Type": "application/json"},
            timeout=_POST_TIMEOUT,
        ) as r:
            if r.status == 401:
                raise api.AuthenticationError("Pairing credential rejected by the doorbell")
            if r.status != 200:
                raise RecSessionError(f"signal POST -> HTTP {r.status}")

    async def _leer(self, primero: asyncio.Future) -> None:
        enviado = False
        try:
            async for linea in self._resp.content:
                linea = linea.strip()
                if not linea.startswith(b"data:"):
                    continue
                try:
                    msg = json.loads(linea[5:])
                except ValueError:
                    continue
                tipo = msg.get("type")

                if tipo == "error" and msg.get("reason") == "sessions_full":
                    self._fallar(primero, RecSessionError("sessions_full"))
                    return

                if tipo == "offer" and self._slot is None and isinstance(msg.get("slot"), int):
                    self._slot = msg["slot"]
                    try:
                        await self._post({"type": "rec_start", "slot": self._slot})
                    except api.DoorbellApiError as err:
                        self._fallar(primero, err)
                        return
                    enviado = True
                    continue

                if not enviado:
                    continue

                if tipo == "rec_error" and not primero.done():
                    primero.set_exception(
                        RecSessionError(_ERRORES.get(msg.get("error"), msg.get("error")))
                    )
                    # Rule: "after every rec_start/rec_stop, accepted or not, the requester also
                    # gets rec_state" (§1.4-quater) - it is on its way, but the refusal already
                    # said everything the caller of start() needs; nothing here waits for it.
                    continue

                if tipo == "rec_state":
                    self.recording = bool(msg.get("recording"))
                    self.kind = msg.get("kind")
                    self.origin = msg.get("origin")
                    self.sd_available = msg.get("sd_available")
                    ya_arrancado = primero.done()
                    if not primero.done():
                        primero.set_result(None)
                    self._on_update()
                    if not self.recording and ya_arrancado:
                        # The doorbell ended it on its own (10 min cap, an admin stopping it from
                        # elsewhere, a ring taking the slot for a call, ...): hold nothing further.
                        asyncio.create_task(self.stop())
                        return
        except asyncio.CancelledError:
            raise
        except (aiohttp.ClientError, OSError) as err:
            ya_arrancado = primero.done()
            self._fallar(primero, api.DoorbellApiError(f"signalling session lost: {err}"))
            if ya_arrancado:
                # start() already returned successfully, so nobody else is waiting to call
                # stop() for this failure - do it here, same as the rec_state branch above.
                asyncio.create_task(self.stop())

    def _fallar(self, primero: asyncio.Future, err: Exception) -> None:
        if not primero.done():
            primero.set_exception(err)
        self.recording = False
        self._on_update()

    async def stop(self) -> None:
        """`rec_stop` (only if still recording) + `bye`, then closes. Idempotent."""
        if self.closed:
            return
        self.closed = True
        if self._slot is not None:
            if self.recording:
                try:
                    await self._post({"type": "rec_stop", "slot": self._slot})
                except Exception:  # noqa: BLE001 - best effort, matching signal_client.async_orden
                    _LOGGER.debug("rec_stop failed", exc_info=True)
            try:
                await self._post({"type": "bye", "slot": self._slot})
            except Exception:  # noqa: BLE001 - the doorbell reaps it at 20 s anyway
                _LOGGER.debug("bye after rec_stop failed", exc_info=True)
        if self._task is not None:
            self._task.cancel()
        if self._resp is not None:
            self._resp.close()
        self.recording = False
        self.kind = None
        self.origin = None
        self._on_update()
