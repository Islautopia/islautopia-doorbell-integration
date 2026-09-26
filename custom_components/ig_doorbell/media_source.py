"""Doorbell recordings, browsable from Home Assistant's own media browser.

Uses `media_source` rather than inventing a panel or a custom card, because that is the primitive
Home Assistant already has for "a device holds recordings you want to look at". The payoff is that
none of the surrounding work has to be written: the media browser dialog, the cast/play-on flows,
the `media_player.play_media` service, and any dashboard card that accepts a media source all get
this for free. A bespoke panel would have to reimplement each of them, worse.

Two things worth knowing before reading further.

**This only works on the LAN, and only through Home Assistant.** The recordings live on the
doorbell's SD card. Home Assistant lists them and serves them to the browser through its own view
(recordings_view.py), fetching them from the doorbell's LAN address with the pairing credential
added server-side. The browser never sees the credential nor the doorbell's cloud hostname (Phase 0,
2026-09-25; until 0.6.x both went to every HA user's browser).

**Downloading is an admin-only action, and this integration is not necessarily an admin.** The
firmware distinguishes listing and viewing (any paired user) from downloading and deleting (admin
only, contract §5 hole 9). Whether Home Assistant can play a recording therefore depends on the
role of the session that paired it. A pairing made from a non-admin session lists recordings fine
and gets 403 on playback. We surface that as a clear error rather than a broken player - see
`async_resolve_media`.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from homeassistant.components.media_player import MediaClass, MediaType
from homeassistant.components.media_source import (
    BrowseMediaSource,
    MediaSource,
    MediaSourceError,
    MediaSourceItem,
    PlayMedia,
    Unresolvable,
)
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from . import api
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN
from .recordings_view import signed_thumbnail_url, signed_video_url

_LOGGER = logging.getLogger(__name__)

# The firmware caps a single list_recordings call at 200 (contract §1.3-bis). Ask for that, once.
# Paging the media browser is deliberately not implemented yet: it would need `offset` state
# carried in the identifier, and 200 recordings is already far more than fits usefully in the
# dialog. What is NOT acceptable is hiding the truncation, so the folder title says how many of
# how many are shown whenever there are more - see `_build_device_node`.
_PAGE_SIZE = 200

# Recording type -> what to call it in a language-neutral way. The firmware's own two types
# (contract §1.3-bis): "event" is AI presence detection, "call" is someone actually speaking.
_TYPE_LABEL = {"event": "Motion", "call": "Call"}


async def async_get_media_source(hass: HomeAssistant) -> MediaSource:
    """Entry point Home Assistant calls to register this source."""
    return DoorbellMediaSource(hass)


class DoorbellMediaSource(MediaSource):
    """Browse and play recordings held on paired IG Doorbells."""

    name = "IG Doorbell"

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(DOMAIN)
        self.hass = hass

    # -- helpers ---------------------------------------------------------------------------

    def _paired_doorbells(self) -> list[dict]:
        """Every config entry that is a paired doorbell, in a stable order.

        Home Assistant is asked which entries exist and each one is looked up, instead of walking
        everything stored under our domain key: there are also live objects there (the
        coordinator), and anything anyone stores tomorrow with a `device_id` inside would silently
        match. Same reasoning as `_find_entry_data` in websocket_api.py.
        """
        stored = self.hass.data.get(DOMAIN, {})
        found = []
        for entry in self.hass.config_entries.async_entries(DOMAIN):
            data = stored.get(entry.entry_id)
            if isinstance(data, dict) and data.get(CONF_DEVICE_ID):
                # The doorbell's own name (`dname`) when known: a manually added doorbell's entry
                # title is its device id, which says nothing to the person browsing.
                coord = data.get("coordinator")
                doorbell_title = (coord.doorbell_name if coord is not None else None) or entry.title
                found.append({**data, "title": doorbell_title})
        return found

    def _doorbell_by_id(self, device_id: str) -> dict:
        for d in self._paired_doorbells():
            if d[CONF_DEVICE_ID] == device_id:
                return d
        raise MediaSourceError(f"Doorbell {device_id} is not configured on this Home Assistant")

    # -- browse ----------------------------------------------------------------------------

    async def async_browse_media(self, item: MediaSourceItem) -> BrowseMediaSource:
        """Root lists doorbells; a doorbell lists its recordings.

        The identifier is `<device_id>` for a doorbell folder and `<device_id>/<filename>` for a
        recording. Nothing else is encoded in it: the filename is exactly what the firmware
        returned, and it validates the format itself before touching the filesystem, so a
        hand-edited identifier gets a clean 400 rather than reaching the SD card.
        """
        if not item.identifier:
            return await self._build_root()

        device_id = item.identifier.split("/", 1)[0]
        return await self._build_device_node(self._doorbell_by_id(device_id))

    async def _build_root(self) -> BrowseMediaSource:
        doorbells = self._paired_doorbells()
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=None,
            media_class=MediaClass.DIRECTORY,
            media_content_type=MediaClass.VIDEO,
            title="IG Doorbell",
            can_play=False,
            can_expand=True,
            children_media_class=MediaClass.DIRECTORY,
            children=[
                BrowseMediaSource(
                    domain=DOMAIN,
                    identifier=d[CONF_DEVICE_ID],
                    media_class=MediaClass.DIRECTORY,
                    media_content_type=MediaClass.VIDEO,
                    # The doorbell's name (the entry title), not the pairing label: since 0.7.0
                    # the label is "Home Assistant <location>", which names this HA, not the door.
                    title=d.get("title") or d[CONF_DEVICE_ID],
                    can_play=False,
                    can_expand=True,
                )
                for d in doorbells
            ],
        )

    async def _build_device_node(self, doorbell: dict) -> BrowseMediaSource:
        device_id = doorbell[CONF_DEVICE_ID]
        credential = doorbell[CONF_CREDENTIAL]
        # The doorbell's LAN session (net.py). No fallback to the shared session: that one
        # resolves names through public DNS, which is exactly what Phase 0 removed.
        session = doorbell.get("session")
        if session is None:
            raise MediaSourceError("The doorbell is still being set up; try again in a moment")

        try:
            listing = await api.async_list_recordings(
                session, device_id, credential, limit=_PAGE_SIZE
            )
        except api.AuthenticationError as err:
            raise MediaSourceError(
                "The doorbell rejected this pairing credential. Re-pair it from "
                "Settings > Devices & services."
            ) from err
        except api.DoorbellApiError as err:
            # Overwhelmingly "not reachable from here". Say so, because the user's next move
            # (check the network / the doorbell is on) is different from a credential problem.
            raise MediaSourceError(str(err)) from err

        items = listing.get("items", [])
        total = listing.get("total", len(items))
        capped = listing.get("capped", False)

        title = doorbell.get("title") or device_id
        if capped:
            # The firmware itself could not sort past its own ceiling; the oldest are unreachable
            # by any page. Never let this read as a complete list.
            title = f"{title} - showing the {len(items)} most recent (2000+ stored)"
        elif total > len(items):
            title = f"{title} - showing {len(items)} of {total}"

        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=device_id,
            media_class=MediaClass.DIRECTORY,
            media_content_type=MediaClass.VIDEO,
            title=title,
            can_play=False,
            can_expand=True,
            children_media_class=MediaClass.VIDEO,
            children=[
                self._recording_node(device_id, rec)
                for rec in items
                if rec.get("file")
            ],
        )

    def _recording_node(
        self, device_id: str, rec: dict
    ) -> BrowseMediaSource:
        filename = rec["file"]
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=f"{device_id}/{filename}",
            media_class=MediaClass.VIDEO,
            media_content_type=MediaType.VIDEO,
            title=_recording_title(rec),
            can_play=True,
            can_expand=False,
            # A signed Home Assistant URL: no credential, no cloud hostname (recordings_view.py).
            thumbnail=signed_thumbnail_url(self.hass, device_id, filename),
        )

    # -- play ------------------------------------------------------------------------------

    async def async_resolve_media(self, item: MediaSourceItem) -> PlayMedia:
        """Hand back a Home Assistant URL for the MP4 (recordings_view.py), never the doorbell's.

        The URL is a signed Home Assistant path (recordings_view.py). The bytes come from the
        doorbell over the LAN with the credential added server-side.

        A 403 here means this pairing was made from a non-admin session, which the firmware allows
        to list and watch but not to download. It must fail with an explanation, not a silently
        dead player - hence the probe first.
        """
        if not item.identifier or "/" not in item.identifier:
            raise Unresolvable("Malformed recording reference")

        device_id, filename = item.identifier.split("/", 1)
        doorbell = self._doorbell_by_id(device_id)
        session = doorbell.get("session")
        if session is None:
            raise Unresolvable("The doorbell is still being set up; try again in a moment")
        try:
            await api.async_check_recording_playable(
                session, device_id, doorbell[CONF_CREDENTIAL], filename
            )
        except api.NotAllowedError as err:
            raise Unresolvable(
                "This Home Assistant is paired as a regular user, which can watch recordings but "
                "not download them. Re-pair from an administrator account of the doorbell."
            ) from err
        except api.AuthenticationError as err:
            raise Unresolvable(
                "The doorbell rejected this pairing credential. Re-pair it from "
                "Settings > Devices & services."
            ) from err
        except api.DoorbellApiError as err:
            raise Unresolvable(str(err)) from err

        return PlayMedia(signed_video_url(self.hass, device_id, filename), "video/mp4")


def _recording_title(rec: dict) -> str:
    """Human-readable label: local date/time, what triggered it, and how big it is.

    Uses the `ts` field, which is the real Unix time the recording was triggered - NOT the digits
    in the filename, which happen to look like a timestamp today and are not documented as one
    (contract §1.3-bis says so explicitly). Rendered in Home Assistant's configured timezone,
    because a user reading "yesterday at 19:40" wants their own clock, not UTC.
    """
    kind = _TYPE_LABEL.get(rec.get("type", ""), rec.get("type", "?"))

    ts = rec.get("ts")
    if isinstance(ts, (int, float)) and ts > 0:
        when = dt_util.as_local(datetime.fromtimestamp(ts, tz=timezone.utc))
        stamp = when.strftime("%Y-%m-%d %H:%M:%S")
    else:
        stamp = "unknown time"

    size = rec.get("size")
    if isinstance(size, (int, float)) and size > 0:
        return f"{stamp} - {kind} ({size / (1024 * 1024):.1f} MB)"
    if size == 0:
        # Real and known: a recording can end up empty when no keyframe was in the buffer at the
        # moment it started. Saying so beats offering a file that plays nothing.
        return f"{stamp} - {kind} (empty)"
    return f"{stamp} - {kind}"
