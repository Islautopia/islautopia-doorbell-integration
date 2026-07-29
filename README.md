# Islautopia Doorbell for Home Assistant

Home Assistant integration for the **IG Doorbell** — a video doorbell that keeps your video and
audio on your own hardware.

Pair it once, and your doorbell's open button starts working with any light, lock, switch or gate
you already have in Home Assistant. No YAML, no automations to write.

> Looking for support for a generic third-party RTSP intercom instead? That is the
> [Islautopia Intercom Engine](https://github.com/Islautopia/ig_hassio_addons), a separate add-on
> with a different job. This repository is the recommended path for IG Doorbell hardware.

---

## What this does

### 1. Makes the doorbell's open button control a real Home Assistant device

Your doorbell can drive a physical relay, or it can ask Home Assistant to do it instead. When you
choose the second option and tell the doorbell which entity to use, this integration takes care of
the rest: someone presses **Open** in the app, and the right thing happens.

It works out which service to call from the kind of entity you chose:

| You point the doorbell at… | Open does | Then, on its own |
|---|---|---|
| `lock.front_door` | `lock.unlock` | `lock.lock` |
| `cover.garage` | `cover.open_cover` | `cover.close_cover` |
| `light.porch` | `light.turn_on` | `light.turn_off` |
| `switch.gate` | `switch.turn_on` | `switch.turn_off` |
| `input_boolean.…` | `turn_on` | `turn_off` |
| `button.…` | `button.press` | — |
| `script.…` / `scene.…` | runs it | — |

The doorbell sends a **close** a few seconds after the open — however many seconds you set as the
open duration — so your lock re-locks and your light turns itself off. Buttons, scripts and scenes
are one-shot by nature, so nothing is sent for them.

Without this integration those messages reach your MQTT broker and nothing listens to them. You
would have to write an automation by hand for every entity you use. That is the problem this solves.

### 2. Pairs your doorbell with Home Assistant, safely

A short form asks for your doorbell and your administrator login. It uses them **once**, to ask the
doorbell for a dedicated access credential, and then discards them. Your administrator password is
never written to disk.

That credential is deliberately limited: it can watch live video and open the door. It cannot
change your doorbell's settings or manage its users.

### 3. Lets the Lovelace card find your doorbell by itself

If you use the [Islautopia Intercom Card](https://github.com/Islautopia/islautopia-intercom-card),
this integration is what lets it work with nothing to copy and paste. It hands the card what a
browser cannot obtain on its own, including the short-lived credentials needed when you are away
from home and the video has to travel through a relay.

---

## What this does *not* do

**Your video and audio never pass through Home Assistant.** The stream goes straight from your
browser to the doorbell, or through a relay when you are away. Home Assistant is not in the middle,
so it is neither a bottleneck nor another copy of your footage.

**It creates no entities of its own.** Your doorbell already publishes its own — ringing, door,
motion, mode — through Home Assistant's MQTT discovery. This integration attaches itself to that
same device instead of creating a second, confusing one.

**It does not poll your doorbell.** No permanent session, no periodic requests.

---

## Before you start

1. **An IG Doorbell that is already set up** — on your network, with an administrator account
   created. If it is brand new, set it up from the mobile app or its own web page first.
2. **The MQTT integration working in Home Assistant**, pointing at the same broker as your
   doorbell. Whatever broker address the doorbell's settings show, Home Assistant must use that one.
3. **Home Assistant 2024.1 or newer.**

---

## Installing

### With HACS (recommended)

1. In HACS, open the **⋮** menu and choose **Custom repositories**.
2. Paste this repository's address and pick the **Integration** category.
3. Find **Islautopia Doorbell** in the list and download it.
4. Restart Home Assistant.

### By hand

Copy the `custom_components/islautopia_doorbell/` folder into your Home Assistant
`custom_components` folder, then restart.

---

## Setting it up

Go to **Settings → Devices & Services → Add Integration** and search for **Islautopia Doorbell**.

If your doorbell is on the same network, Home Assistant may find it on its own and offer it under
*Discovered* — then you only need to log in.

Otherwise, type your doorbell's address by hand. Both routes work equally well, and typing the
address is the reliable one when your doorbell and Home Assistant sit on different network
segments, where automatic discovery cannot reach across.

Then enter the administrator email and password you created on the doorbell. That is all.

### Making the open button work

On the doorbell itself, set the door type to **Home Assistant** and fill in the entity you want it
to control — `light.porch`, for example. There is nothing to configure on the Home Assistant side:
this integration is already listening.

---

## If something does not work

**Nothing happens when the door is opened.** Check that the doorbell's door type is set to Home
Assistant and that the entity name is spelled exactly as Home Assistant shows it. Then check that
the doorbell and Home Assistant use the same MQTT broker — that is the most common cause by far.

**It opens but never closes.** Make sure this integration is up to date. Automatic closing arrived
in version 0.3.0; earlier versions ignored the close message and left the light or lock open
forever.

**The device shows up with no entities.** Those entities come from the doorbell over MQTT
discovery, not from this integration. Check that the MQTT integration is configured and that the
doorbell reports the same broker.

For more detail, add this to your `configuration.yaml` and restart:

```yaml
logger:
  logs:
    custom_components.islautopia_doorbell: debug
```

---

## Privacy

Video and audio stay on your doorbell and travel directly to whoever is watching. Recordings live
on the doorbell's own memory card and nowhere else.

When you are away from home and a direct connection is not possible, the stream is relayed — but it
stays encrypted end to end the whole way, so the relay passes it along without being able to read
it or keep it.

---

## License

MIT — see [LICENSE](LICENSE).

Made by [Islautopia Garage](https://islautopia.com).
