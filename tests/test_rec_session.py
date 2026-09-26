"""REC has to stay recording after the session that started it would normally have said `bye`.

API_CONTRACT.md §1.4-quater rule 4: a manual recording stops the moment the session that pressed
REC ends. Found on the Waveshare (fw 0.100.0, 2026-09-25): `signal_client.async_orden` always says
`bye` right after the first reply, so a `rec_start` sent that way recorded for a fraction of a
second. `RecSession` (rec_session.py) is the fix: it keeps the SSE open and only says `bye` when
the RECORDING itself is over - by the user, or by the doorbell.

The doorbell is faked at the session level, like test_signal_actions.py, but persistent: `get()`
returns a queue-backed stream the test can keep pushing to, to simulate the doorbell ending the
recording on its own (10 min cap, another admin, a ring) while the session is still held.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from custom_components.ig_doorbell.rec_session import RecSession, RecSessionError

from .conftest import CREDENTIAL, DEVICE_ID


class _FakeDoorbell:
    def __init__(self, respuestas: dict[str, dict | None]):
        self.posts: list[dict] = []
        self.cola: asyncio.Queue = asyncio.Queue()
        self.respuestas = respuestas
        self.cerrada = False

    async def get(self, url, **kw):
        assert url.startswith(f"https://{DEVICE_ID}.doorbell.islautopia.com:8443/webrtc/signal?token=")
        await self.cola.put({"type": "offer", "slot": 5, "sdp": "v=0"})
        fake = self

        class _Resp:
            status = 200

            class content:  # noqa: N801
                def __aiter__(self_inner):
                    return self_inner

                async def __anext__(self_inner):
                    msg = await fake.cola.get()
                    return b"data: " + json.dumps(msg).encode() + b"\n"

            content = content()

            def close(self_inner):
                fake.cerrada = True

        return _Resp()

    def post(self, url, data=None, **kw):
        msg = json.loads(data)
        self.posts.append(msg)
        fake = self

        class _Ctx:
            status = 200

            async def __aenter__(self_inner):
                respuesta = fake.respuestas.get(msg["type"])
                if respuesta is not None:
                    await fake.cola.put(respuesta)
                return self_inner

            async def __aexit__(self_inner, *a):
                return False

        return _Ctx()

    async def empujar(self, msg: dict) -> None:
        """Something the doorbell pushes on its own, unprompted by a POST of ours."""
        await self.cola.put(msg)


async def _esperar(evento: asyncio.Event) -> None:
    await asyncio.wait_for(evento.wait(), 1)
    evento.clear()


async def test_rec_start_accepted_holds_the_session_open():
    fake = _FakeDoorbell({
        "rec_start": {"type": "rec_state", "slot": 5, "recording": True, "kind": "manual",
                       "origin": "manual", "sd_available": True},
    })
    session = RecSession(fake, DEVICE_ID, CREDENTIAL, lambda: None)

    await session.start()

    assert session.recording is True
    assert session.kind == "manual"
    assert fake.posts[0] == {"type": "rec_start", "slot": 5}
    # The whole point: unlike a quick reply/sequence, no `bye` yet - the slot is still held.
    assert not any(p["type"] == "bye" for p in fake.posts)
    assert not fake.cerrada

    await session.stop()


async def test_admin_stops_it_from_home_assistant_sends_rec_stop_then_bye():
    fake = _FakeDoorbell({
        "rec_start": {"type": "rec_state", "slot": 5, "recording": True, "kind": "manual",
                       "origin": "manual", "sd_available": True},
    })
    session = RecSession(fake, DEVICE_ID, CREDENTIAL, lambda: None)
    await session.start()

    await session.stop()

    assert [p["type"] for p in fake.posts] == ["rec_start", "rec_stop", "bye"]
    assert fake.posts[-1] == {"type": "bye", "slot": 5}
    assert session.recording is False
    assert session.closed
    assert fake.cerrada


async def test_the_doorbell_ending_it_on_its_own_frees_the_slot_without_being_told():
    """10-minute cap, another admin, a ring taking the slot - whatever the reason, a pushed
    `rec_state:false` after we are already recording must close OUR session too, unprompted."""
    fake = _FakeDoorbell({
        "rec_start": {"type": "rec_state", "slot": 5, "recording": True, "kind": "manual",
                       "origin": "manual", "sd_available": True},
    })
    evento = asyncio.Event()
    session = RecSession(fake, DEVICE_ID, CREDENTIAL, evento.set)
    await session.start()
    evento.clear()

    await fake.empujar({"type": "rec_state", "slot": 5, "recording": False, "kind": None,
                         "origin": None, "sd_available": True})

    await _esperar(evento)   # the rec_state push itself: recording flips to False at once
    assert session.recording is False
    await _esperar(evento)   # the session's own stop(): closed becomes True, bye is sent

    assert session.closed
    assert fake.posts[-1] == {"type": "bye", "slot": 5}
    # Not "rec_stop": the doorbell already stopped it, nothing to ask it to stop again.
    assert not any(p["type"] == "rec_stop" for p in fake.posts)
    assert fake.cerrada


async def test_admin_required_refusal_still_frees_the_slot():
    fake = _FakeDoorbell({
        "rec_start": {"type": "rec_error", "slot": 5, "error": "admin_required"},
    })
    session = RecSession(fake, DEVICE_ID, CREDENTIAL, lambda: None)

    with pytest.raises(RecSessionError):
        await session.start()

    assert session.recording is False
    assert session.closed
    assert fake.posts[-1] == {"type": "bye", "slot": 5}


async def test_no_answer_at_all_times_out_and_still_says_bye():
    fake = _FakeDoorbell({})
    session = RecSession(fake, DEVICE_ID, CREDENTIAL, lambda: None)

    with pytest.raises(RecSessionError):
        await session.start(plazo=0.3)

    assert fake.posts[-1] == {"type": "bye", "slot": 5}
    assert session.closed


async def test_stop_before_start_and_stop_twice_are_both_no_ops():
    fake = _FakeDoorbell({})
    session = RecSession(fake, DEVICE_ID, CREDENTIAL, lambda: None)
    await session.stop()          # never started: no slot, nothing to say bye to
    assert fake.posts == []
    assert session.closed

    await session.stop()          # already closed: idempotent, no second round of posts
    assert fake.posts == []
