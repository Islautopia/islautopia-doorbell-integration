import ssl, socket, sys
from cryptography import x509
host, port, local_ca, pub_ca = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
def hs(sni, cafile, check_name):
    ctx = ssl.create_default_context(cafile=cafile)
    ctx.check_hostname = check_name is not None
    s = socket.create_connection((host, port), timeout=5)
    try:
        t = ctx.wrap_socket(s, server_hostname=sni)
        c = x509.load_der_x509_certificate(t.getpeercert(True)); t.close()
        return "OK  " + c.issuer.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value
    except ssl.SSLCertVerificationError as e:
        return "FAIL " + e.verify_message
cases = [
 ("bare IP 192.168.41.125 (no SNI sent)", "192.168.41.125", local_ca, "x"),
 ("SNI homeassistant.local", "homeassistant.local",             local_ca, "x"),
 ("SNI public name",         "poctest.ha.doorbell.islautopia.com", pub_ca, "x"),
 ("SNI unknown name",        "wrong.example.com",               local_ca, None),
 ("NEG public name vs local CA", "poctest.ha.doorbell.islautopia.com", local_ca, "x"),
 ("NEG bare IP vs public CA", "192.168.41.125", pub_ca, "x"),
 ("NEG hostname check: unknown name vs local CA", "wrong.example.com", local_ca, "x"),
]
for label, sni, ca, chk in cases:
    print(f"{label:48s} {hs(sni, ca, chk)}")
