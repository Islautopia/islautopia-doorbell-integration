"""Mutation check for the Phase 0 rules: each mutant undoes ONE rule and the suite must go red.

    python tools/mutantes.py          (from the repo root, where `pytest tests` works)

A test suite that always said "green" would pass every negative test; these mutants are the
positive controls. Every anchor must appear EXACTLY once or the run aborts (a replace() on a
missing anchor returns the text unchanged and would report a "surviving" mutant that was never
applied -- the failure CLAUDE.md warns about).
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

RAIZ = pathlib.Path(__file__).resolve().parent.parent
PKG = "custom_components/islautopia_doorbell/"

MUTANTES = [
    ("resolver falls back to DNS", PKG + "net.py",
     "        lan = self._mapeo.get(host)\n        if lan is None:\n",
     "        lan = self._mapeo.get(host)\n        if lan is None:\n            import socket as _s; _s.getaddrinfo(host, port)\n"),
    ("get_connection_info returns the credential", PKG + "websocket_api.py",
     '            "device_id": device_id,\n            "live_timeout_entity"',
     '            "device_id": device_id,\n            "credential": entry_data["credential"],\n            "live_timeout_entity"'),
    ("playback URL points the browser at the doorbell with ?token=", PKG + "media_source.py",
     "        return PlayMedia(signed_video_url(self.hass, device_id, filename), \"video/mp4\")",
     "        return PlayMedia(api.recording_url(device_id, doorbell[CONF_CREDENTIAL], filename), \"video/mp4\")"),
    ("recordings view without auth", PKG + "recordings_view.py",
     "    requires_auth = True", "    requires_auth = False"),
    ("failed pairing is not undone", PKG + "config_flow.py",
     "            deshecho = await api.async_unpair_app(session, device_id, label)",
     "            deshecho = False"),
    ("setup skips the TLS check", PKG + "config_flow.py",
     "        await api.async_check_tls(sesion, encontrado)", "        pass"),
    ("cloud hostname resolved at setup", PKG + "config_flow.py",
     "    if not host or host.lower().rstrip(\".\").endswith(DOORBELL_HOSTNAME_SUFFIX):\n        return None\n",
     "    if not host:\n        return None\n"),
    ("live timeout default changed", PKG + "const.py",
     "LIVE_TIMEOUT_DEFAULT_S = 120", "LIVE_TIMEOUT_DEFAULT_S = 60"),
    ("an entity back to a hard-coded Spanish name", PKG + "button.py",
     '    _attr_translation_key = "open_door"\n', '    _attr_name = "Abrir puerta"\n'),
    ("signalling command leaves the slot to the 20 s reaper", PKG + "signal_client.py",
     '                await _post({"type": "bye", "slot": slot})', "                pass"),
    ("undo by label (404 with spaces on the firmware)", PKG + "api.py",
     'f"{base}/api/unpair_app", data={"slot": str(slots[0])}', 'f"{base}/api/unpair_app", data={"label": label}'),
    ("a language loses an entity name", PKG + "translations/de.json",
     '"name": "Tür öffnen"', '"nombre": "Tür öffnen"'),
]


def main() -> int:
    vivos = []
    for nombre, fichero, ancla, cambio in MUTANTES:
        with tempfile.TemporaryDirectory() as tmp:
            copia = pathlib.Path(tmp) / "repo"
            shutil.copytree(RAIZ, copia, ignore=shutil.ignore_patterns(".git", "__pycache__"))
            ruta = copia / fichero
            texto = ruta.read_text(encoding="utf-8")
            n = texto.count(ancla)
            if n != 1:
                print(f"ABORT: anchor for '{nombre}' appears {n} times in {fichero}")
                return 2
            ruta.write_text(texto.replace(ancla, cambio), encoding="utf-8")
            r = subprocess.run(
                [sys.executable, "-m", "pytest", "tests", "-q", "-x", "-p", "no:cacheprovider"],
                cwd=copia, capture_output=True, text=True,
            )
            rojo = r.returncode != 0
            print(f"{'RED   (killed)' if rojo else 'GREEN (SURVIVED)'}  {nombre}")
            if not rojo:
                vivos.append(nombre)
    print(f"\n{len(MUTANTES) - len(vivos)}/{len(MUTANTES)} mutants killed")
    return 1 if vivos else 0


if __name__ == "__main__":
    sys.exit(main())
