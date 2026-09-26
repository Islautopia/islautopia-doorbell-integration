"""Serve the Lovelace card from the integration itself.

The card used to be a separate HACS repository, installed on its own and added by hand as a
dashboard resource. Two installs that had to agree on versions, and one manual step that a user
who skipped it paid for with a "Custom element doesn't exist" error. Since 1.0.0 the card ships
inside this integration: installing the integration IS installing the card.

How it reaches the browser:

  1. `frontend/ig-doorbell-card.js` is served at `CARD_URL` as a static file.
  2. That URL is registered as an extra frontend module (`frontend.add_extra_js_url`), which is
     what Home Assistant puts in every page it serves - so the card is defined on every
     dashboard with no Lovelace resource at all, and `window.customCards` makes it show up in
     the card picker.

CACHE BUSTING. The module URL carries `?v=<first 12 hex of the file's SHA-256>`. The hash, and
not the version number, because what the browser must not reuse is a different FILE: a build
that forgot to bump the version (or a local edit while debugging) still changes the hash. A new
integration version needs a Home Assistant restart anyway (new Python), and on that restart the
new URL goes into the page; `add_extra_js_url` also notifies pages that are already open.

The static route is registered WITHOUT long-lived cache headers (`cache_headers=False`), so even
a request for the same URL revalidates instead of trusting a month-old copy. Measured behaviour
per update path is in docs/card.md ("Updating the card").
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CARD_FILENAME = "ig-doorbell-card.js"
CARD_PATH = Path(__file__).parent / "frontend" / CARD_FILENAME
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"
# The module URL actually registered (with its ?v=); also a "done" marker so a reload of the
# integration does not register the static route twice (aiohttp raises on a duplicate route).
DATA_CARD_URL = f"{DOMAIN}_card_url"


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def async_register_card(hass: HomeAssistant) -> str | None:
    """Serve the card and load it on every frontend page. Returns the module URL."""
    if DATA_CARD_URL in hass.data:
        return hass.data[DATA_CARD_URL]
    if not CARD_PATH.is_file():
        # Loud, not silent: a missing card is a broken install, and an empty dashboard with no
        # log line is the failure that costs an afternoon.
        _LOGGER.error("The card file is missing from the install: %s", CARD_PATH)
        return None
    digest = await hass.async_add_executor_job(_file_digest, CARD_PATH)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(CARD_PATH), False)]
    )
    url = f"{CARD_URL}?v={digest}"
    hass.data[DATA_CARD_URL] = url
    if "frontend" not in hass.config.components:
        # Only happens in a stripped-down HA (or a test harness): the frontend is loaded in
        # bootstrap's first stage on every normal install, and after_dependencies orders us
        # after it. Said out loud because the symptom would be "the card does not exist".
        _LOGGER.warning("The frontend is not loaded: the card is served at %s but not "
                        "added to the pages", url)
        return url
    from homeassistant.components.frontend import add_extra_js_url

    add_extra_js_url(hass, url)
    _LOGGER.debug("Card served and added to the frontend as %s", url)
    return url
