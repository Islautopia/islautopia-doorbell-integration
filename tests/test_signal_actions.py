"""Quick replies and sequences go over the signalling channel, like the apps, and never leave a slot.

The doorbell is faked at the session level: an SSE that sends an offer with a slot, and a POST
endpoint that records what arrives and answers through the SSE.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from custom_components.ig_doorbell import signal_client

from .conftest import CREDENTIAL, DEVICE_ID


class _FakeDoorbell:
    def __init__(self, response_type: dict | None):
        self.posts: list[dict] = []
        self.queue: asyncio.Queue = asyncio.Queue()
        self.response_type = response_type
        self.closed = False

    # -- SSE --------------------------------------------------------------------------------
    async def get(self, url, **kw):
        assert url.startswith(f"https://{DEVICE_ID}.doorbell.islautopia.com:8443/webrtc/signal?token=")
        await self.queue.put({"type": "offer", "slot": 5, "sdp": "v=0"})
        fake = self

        class _Resp:
            status = 200

            class content:  # noqa: N801
                def __aiter__(self_inner):
                    return self_inner

                async def __anext__(self_inner):
                    msg = await fake.queue.get()
                    return b"data: " + json.dumps(msg).encode() + b"\n"

            content = content()

            def close(self_inner):
                fake.closed = True

        return _Resp()

    # -- POST -------------------------------------------------------------------------------
    def post(self, url, data=None, **kw):
        msg = json.loads(data)
        self.posts.append(msg)
        fake = self

        class _Ctx:
            status = 200

            async def __aenter__(self_inner):
                if msg["type"] != "bye" and fake.response_type is not None:
                    await fake.queue.put(fake.response_type)
                return self_inner

            async def __aexit__(self_inner, *a):
                return False

        return _Ctx()


async def test_sequence_goes_with_the_slot_and_the_session_is_closed():
    fake = _FakeDoorbell({"type": "play_sequence_result", "slot": 5, "status": "playing"})
    r = await signal_client.async_send_command(
        fake, DEVICE_ID, CREDENTIAL, {"type": "play_sequence", "seq_id": 3}, "play_sequence_result"
    )
    assert r["status"] == "playing"
    assert fake.posts[0] == {"type": "play_sequence", "seq_id": 3, "slot": 5}
    assert fake.posts[-1] == {"type": "bye", "slot": 5}
    assert fake.closed


async def test_no_answer_still_says_bye():
    fake = _FakeDoorbell(None)
    with pytest.raises(signal_client.SignalError):
        await signal_client.async_send_command(
            fake, DEVICE_ID, CREDENTIAL, {"type": "play_audio", "audio_slot": 1},
            "play_audio_result", timeout_s=0.3,
        )
    assert fake.posts[-1] == {"type": "bye", "slot": 5}
    assert fake.closed
