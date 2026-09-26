"""Asks the doorbell for its state, and every entity lives off that.

## Why poll at all if the webhook pushes

Because they are two different things. The webhook brings **what happens** - someone rang, there
is a package, the door opened - and polling brings **how things are** - what mode, how many people
are watching, whether there is a street panel, what firmware is running. The second kind changes
without anyone announcing it: the mode is touched from the doorbell's own dashboard, §1.12-ter's
scheduler changes it on its own, and a panel shows up the moment someone plugs in a cable.

And it does a third job that used to be MQTT's LWT: **availability**. If `get_states` fails, the
entities go unavailable. That comes free from polling, whereas with MQTT you had to configure a
last-will message - one more piece that could be left unconfigured.

## Why 30 s and not 5

Almost everything that changes fast arrives pushed. Polling more often would punish the doorbell
to refresh things that almost never move, and `esp_http_server` **serves one request at a time**:
a slow request leaves the whole device unable to answer anything else while it runs. That effect
was already measured with the recordings listing, where a 0.31 s `/api/device_id` went up to 22.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from . import api
from .const import DOMAIN, POLL_INTERVAL, generic_name

_LOGGER = logging.getLogger(__name__)


class DoorbellCoordinator(DataUpdateCoordinator[dict]):
    """One doorbell. `data` is `get_states` with `firmware_info` mixed into it."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        device_id: str,
        credential: str,
        session: aiohttp.ClientSession,
        address: str | None = None,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}_{device_id}",
            update_interval=timedelta(seconds=POLL_INTERVAL),
            # `config_entry` stopped being optional: without it, Home Assistant warns, and on
            # newer versions refuses to build the coordinator.
            config_entry=entry,
        )
        self.device_id = device_id
        self.credential = credential
        # The doorbell's LAN address (net.py). Only for display (configuration_url); requests go
        # through the session, whose resolver already maps the name to it.
        self.address = address
        # THIS entry's session, with the resolver that tries the local address before public DNS
        # (net.py). Not the shared one: a resolver on that one would answer for every integration
        # on this Home Assistant.
        self._session = session
        # `firmware_info` is only asked for once in a while: the version does not change on its
        # own, and asking every 30 s would be one more request against a device that serves one
        # at a time. It refreshes after an OTA because the doorbell reboots and the next poll
        # fails, which resets this to zero. So the update is noticed without asking often.
        self._cycles_until_firmware = 0
        self._firmware: dict = {}
        # THIS credential's role on the doorbell ("admin"/"user"/"unknown", §3.3-ter) - this is
        # what the card is allowed to show (REC, hass_todo_en_la_integracion), never whether
        # whoever is looking at the dashboard is a HOME ASSISTANT administrator. Same cadence as
        # firmware_info: it does not change on its own, so asking every 30 s would be one more
        # request against a device that serves one at a time.
        self._cycles_until_role = 0
        self._role = "unknown"

    @property
    def session(self) -> aiohttp.ClientSession:
        """This doorbell's session, for whoever has the coordinator and not hass.data."""
        return self._session

    async def _async_update_data(self) -> dict:
        try:
            state = await api.async_get_states(self._session, self.device_id, self.credential)
        except api.AuthenticationError as err:
            # ⚠️ A 401 on a credential that USED TO work is not a network failure: it means that
            # doorbell no longer recognises this integration - factory reset, revocation, or the
            # slot evicted by age (§1.5, 16 slots, the oldest goes). In all three cases the only
            # fix is re-pairing, so that is what is said instead of retrying in a loop.
            raise UpdateFailed(
                "The doorbell no longer recognises this integration: re-pair it"
            ) from err
        except api.DoorbellApiError as err:
            raise UpdateFailed(str(err)) from err

        if self._cycles_until_firmware <= 0:
            try:
                self._firmware = await api.async_get_firmware_info(
                    self._session, self.device_id, self.credential
                )
                self._cycles_until_firmware = 20     # ~10 minutes
            except api.DoorbellApiError:
                # Not a reason to leave the entities without data: `get_states` already answered,
                # so the doorbell is alive. Retried on the next cycle.
                _LOGGER.debug("Could not read firmware_info; will retry", exc_info=True)
        else:
            self._cycles_until_firmware -= 1

        if self._cycles_until_role <= 0:
            self._role = await api.async_get_role(self._session, self.device_id, self.credential)
            self._cycles_until_role = 20     # ~10 minutes, same as firmware_info
        else:
            self._cycles_until_role -= 1

        # Mixed into a single dict so the entities do not have to know which of the two routes
        # each field comes from. `get_states` wins: if the two ever returned the same key, the
        # state one is the one refreshed every 30 s.
        return {**self._firmware, **state}

    # -- helpers several entities use -----------------------------------------------------------

    @property
    def doorbell_name(self) -> str:
        """`dname`, and if the doorbell has no name, the firmware's own generic one.

        Empty means "nobody has named it", not a name (§1.4-ter): stomping what the client already
        had with that would leave it worse than before. And the generic name - never the bare id
        (Inaki, 2026-09-26) - is the same one the firmware uses for its mDNS instance when it too
        has no name, see `generic_name`.
        """
        return (self.data or {}).get("dname") or generic_name(self.device_id)

    @property
    def role(self) -> str:
        """"admin" / "user" / "unknown" - this pairing's role on the doorbell (§3.3-ter).

        What the card is allowed to show (get_connection_info, websocket_api.py) - not a live
        signalling field, refreshed on the same slow cadence as firmware_info, but the SAME
        `paired_app_role[]` lookup the doorbell does for `session_info.role`.
        """
        return self._role

    @property
    def has_lock(self) -> bool:
        """`door_m=2` is "none" (§1.2).

        With that, the open button **is not drawn** (§1.4-ter). Before `door_m` was carried, a
        client could only find out by **failing**: it offered the button, got a
        `no_lock_configured`, and only then hid it - so the first user of every session saw a
        button that does not work, and on a video doorbell that is exactly the button that cannot
        disappoint.
        """
        return (self.data or {}).get("door_m", 2) != 2
