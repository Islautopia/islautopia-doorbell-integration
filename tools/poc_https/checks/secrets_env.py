import re
def load():
    out = {}
    with open(r"C:\Proyectos_espressif\EQUIPO-SECRETS.env", encoding="utf-8") as f:
        for line in f:
            m = re.match(r'^\s*(?:export\s+)?(HASS_URL|HASS_TOKEN)\s*=\s*(.*?)\s*$', line)
            if m:
                v = m.group(2).strip().strip('"').strip("'")
                out[m.group(1)] = v
    return out
