"""Constants for the Islautopia Doorbell integration.

See ARCHITECTURE.md (repo root) for the design this implements, and
API_CONTRACT.md in the IG_Doorbell firmware repo for the interface these values come from.
"""
from __future__ import annotations

DOMAIN = "islautopia_doorbell"

# --- MQTT (API_CONTRACT.md §4) --------------------------------------------------------------
# Flat topic, NOT scoped per device_id - see COORDINATION.md Q3. We don't need it scoped: the
# entity_id to act on travels inside the JSON payload itself.
MQTT_DOOR_ACTION_TOPIC = "videoportero/door/action"

# --- Config entry data keys -----------------------------------------------------------------
CONF_DEVICE_ID = "device_id"
CONF_CREDENTIAL = "credential"
CONF_HOST_HINT = "host_hint"
CONF_LABEL = "label"

# Confirmed with firmware lead 2026-07-09 (COORDINATION.md Q5): use this fixed label so every
# HA instance that pairs with a given doorbell is identifiable in the cloud admin panel.
DEFAULT_PAIR_LABEL = "Home Assistant"

# --- Zeroconf (API_CONTRACT.md §0-bis) ------------------------------------------------------
# Only used for the OPTIONAL pairing-discovery step in config_flow.py (async_step_zeroconf) -
# HA Core matches this against manifest.json's own "zeroconf": ["_igdoorbell._tcp.local."]
# declaration (the actual source of truth for that, not a Python constant) and routes matching
# announcements there. Match discovered instances by the `device_id` TXT record, NEVER by the
# mDNS instance name - the instance name tracks the doorbell's user-editable `device_name` and
# can change at any time (confirmed by firmware lead 2026-07-09, COORDINATION.md Q6).
#
# Deliberately NOT relied on anywhere else (2026-07-10, see COORDINATION.md): a previous
# `discovery.py` module used mDNS to resolve a doorbell's current LAN IP on every card session
# start - removed entirely. Two independent reasons: the card never actually used that value to
# connect (always uses the public hostname, see ARCHITECTURE.md §5/§7 "Q7"), and mDNS is
# multicast, which normally does not cross VLAN/subnet boundaries - relying on it would be
# actively wrong (not just unused) for any doorbell provisioned manually by IP because it lives
# on a different VLAN/subnet than the HA host, a real, legitimate setup. Pairing discovery here
# stays fine because it's purely optional/opportunistic - manual IP entry in config_flow.py
# always works as the real fallback, regardless of network segmentation.
#
# --- HTTP -------------------------------------------------------------------------------------
REQUEST_TIMEOUT = 8  # seconds - these are one-shot REST calls (pairing, TURN creds), not streams

# --- Relay / cloud (API_CONTRACT.md §3) -------------------------------------------------------
RELAY_HOST = "relay.doorbell.islautopia.com"
DOORBELL_HOSTNAME_SUFFIX = "doorbell.islautopia.com"

# --- videoportero/door/action dispatch table (the actual point of this integration) -----------
# entity_id domain -> (service domain, service name). Extend this table, don't special-case
# individual entities - see mqtt_dispatch.py.
DOMAIN_OPEN_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "unlock"),
    "cover": ("cover", "open_cover"),
    "light": ("light", "turn_on"),
    "switch": ("switch", "turn_on"),
    "button": ("button", "press"),
    "input_boolean": ("input_boolean", "turn_on"),
    "script": ("script", "turn_on"),
    "scene": ("scene", "turn_on"),
}
# Best-effort for any domain not in the table above - logged loudly so the gap is visible
# instead of a silent no-op. See mqtt_dispatch.py.
FALLBACK_SERVICE: tuple[str, str] = ("homeassistant", "turn_on")

# Symmetric "close" table, added 2026-07-11 (COORDINATION.md Q25) after a real bug: the firmware
# (main/hardtask.c::open_door(), fixed the same day) now publishes a "close" action
# ({"action":"close","entity_id":"<same ha_e>"}) on MQTT_DOOR_ACTION_TOPIC automatically
# `open_duration_s` seconds after "open", in door_m=1 (Home Assistant) mode - symmetric with what
# the physical relay (door_m=0) has always done. Before this table existed, mqtt_dispatch.py
# discarded any action != "open" outright, so the light/switch/lock/cover the user configured as
# `ha_e` would open and then just... stay open forever, no error, no warning: a real production
# bug ("la luz se enciende pero nunca se apaga sola"), not a missing feature request.
#
# Deliberately NOT a mirror of DOMAIN_OPEN_SERVICE with every domain filled in: "button" and
# "scene" (and, by the same reasoning, "script") don't have a natural "close" - a button doesn't
# "unpress", a scene/script is a one-shot action with no defined opposite state to return to.
# Forcing them into this table with a made-up fallback would be worse than doing nothing - see
# mqtt_dispatch.py, where a "close" for a domain missing here is a silent DEBUG no-op, not the
# loud WARNING that a missing "open" mapping gets (an "open" gap is a real hole to fill; a
# "close" gap for one of these three is a legitimate property of the domain, not a hole).
DOMAIN_CLOSE_SERVICE: dict[str, tuple[str, str]] = {
    "lock": ("lock", "lock"),
    "cover": ("cover", "close_cover"),
    "light": ("light", "turn_off"),
    "switch": ("switch", "turn_off"),
    "input_boolean": ("input_boolean", "turn_off"),
}
