"""1.0.0: the card ships inside the integration and needs no Lovelace resource.

Checked on the real `async_setup`: the card file is served, its URL goes into the frontend's
extra-module list (what makes it load on every page with no resource), the URL changes when the
file changes (cache busting), and the route does not tell browsers to keep a copy for a month.
tools/mutants.py breaks each of those in turn.
"""
from __future__ import annotations

import hashlib
import logging

from homeassistant.setup import async_setup_component

from custom_components.ig_doorbell import card
from custom_components.ig_doorbell.const import DOMAIN


class _FakeUrlManager:
    """Stands in for frontend.UrlManager (the harness has no frontend package to set up)."""

    def __init__(self) -> None:
        self.urls: list[str] = []

    def add(self, url: str) -> None:
        self.urls.append(url)


def _pretend_frontend_is_loaded(hass) -> _FakeUrlManager:
    from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL

    manager = _FakeUrlManager()
    hass.data[DATA_EXTRA_MODULE_URL] = manager
    hass.config.components.add("frontend")
    return manager


async def test_setup_serves_the_card_and_adds_it_to_every_page(hass, hass_client_no_auth):
    manager = _pretend_frontend_is_loaded(hass)
    assert await async_setup_component(hass, DOMAIN, {})
    await hass.async_block_till_done()

    expected = hashlib.sha256(card.CARD_PATH.read_bytes()).hexdigest()[:12]
    assert manager.urls == [f"/{DOMAIN}/ig-doorbell-card.js?v={expected}"]

    client = await hass_client_no_auth()
    resp = await client.get(manager.urls[0])
    assert resp.status == 200
    assert await resp.read() == card.CARD_PATH.read_bytes()
    assert "max-age" not in resp.headers.get("Cache-Control", "")


async def test_the_card_defines_its_element_and_offers_itself_to_the_picker():
    text = card.CARD_PATH.read_text(encoding="utf-8")
    assert "const CARD_TAG = 'ig-doorbell-card';" in text
    assert "window.customCards" in text
    assert "const IG_DOMAIN = 'ig_doorbell';" in text


async def test_a_changed_card_file_gets_a_new_url(hass, tmp_path, monkeypatch):
    first = tmp_path / "a.js"
    first.write_text("console.log('one');", encoding="utf-8")
    second = tmp_path / "b.js"
    second.write_text("console.log('two');", encoding="utf-8")
    await async_setup_component(hass, "http", {})

    monkeypatch.setattr(card, "CARD_PATH", first)
    url_one = await card.async_register_card(hass)
    hass.data.pop(card.DATA_CARD_URL)
    monkeypatch.setattr(card, "CARD_URL", "/ig_doorbell_test/other.js")
    monkeypatch.setattr(card, "CARD_PATH", second)
    url_two = await card.async_register_card(hass)
    assert url_one.split("?v=")[1] != url_two.split("?v=")[1]


async def test_a_second_setup_does_not_register_the_route_twice(hass):
    _pretend_frontend_is_loaded(hass)
    await async_setup_component(hass, "http", {})
    first = await card.async_register_card(hass)
    again = await card.async_register_card(hass)   # aiohttp would raise on a duplicate route
    assert first == again


async def test_without_the_frontend_it_says_so(hass, caplog):
    await async_setup_component(hass, "http", {})
    with caplog.at_level(logging.WARNING):
        url = await card.async_register_card(hass)
    assert url is not None
    assert "frontend is not loaded" in caplog.text
