# Layout matrix, card 1.9.8, against a real Home Assistant

`run.js` creates a temporary storage dashboard (`igd-card-layout-test`, title
"IGD card layout test (temporary)") with the card in Sections, Masonry, Sidebar (main column),
Sidebar (side column), Panel and Panel with `height: 600px`, opens each view at five device sizes in
headless Chromium, waits for real video (`currentTime > 1.5 s`), screenshots it and writes the
geometry to `metrics.json`. It only ever targets the config entry titled `Waveshare` (override with
`TARGET_TITLE`) and refuses anything named "Ermita". One page at a time; each is closed before the next.

```bash
# from the repo root; HASS_URL / HASS_TOKEN come from the team secrets file (never write them to disk)
HASS_URL=... HASS_TOKEN=... node test/layout_matrix_1_9_8/run.js all          # setup + capture + teardown
HASS_URL=... HASS_TOKEN=... node test/layout_matrix_1_9_8/run.js capture _pc_  # filter by name
HASS_URL=... HASS_TOKEN=... node test/layout_matrix_1_9_8/run.js teardown      # always run if a capture aborts
```

Files are `<view>_<size>_<orientation>.png`. Sizes: `phone_port` 390x844, `phone_land` 844x390,
`tablet_port` 800x1280, `tablet_land` 1280x800 (touch, DPR 2/1.5), `pc` 1920x1080.

**Orientation is simulated page-side.** The Waveshare streams 1080x1200 with `rot 0` (`*_native.png`),
which is neither 9:16 nor 16:9. `portrait` / `landscape` override the card's `_contentSize()` to
720x1280 / 1280x720 and neutralise `_applyRotation`; every layout decision in the card goes through
`_contentSize()`, so the geometry is what a real stream of that shape gets. The picture itself is
stretched (`object-fit: fill`) and clipped to that rect, so it looks distorted: judge layout, not image.
The doorbell's settings are never changed.

Requires `playwright-core` (repo `node_modules`) and a Chromium binary (`CHROME` env var to override).
