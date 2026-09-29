"""
serve.py - run the app on your computer and open it on your phone.

    python serve.py

    On this computer : http://localhost:8000
    On your phone    : https://<this computer's IP>:8443   (same Wi-Fi network)

Why two addresses? Browsers only allow the camera on "secure" pages: https://...
or http://localhost. On the computer, localhost is fine. Your phone is another
device, so it needs https. This script makes a self-signed certificate for that:
the phone will warn "not private / not secure" -> tap "Advanced" -> "Proceed"
(Safari: "Show details" -> "visit this website").

Privacy: this server only sends the app's files. The camera images are
processed inside the browser and never leave the phone.
"""

import datetime
import http.server
import ipaddress
import os
import socket
import ssl
import sys
import threading
from functools import partial

ROOT = os.path.dirname(os.path.abspath(__file__))
HTTP_PORT = 8000
HTTPS_PORT = 8443
CERT_DIR = os.path.join(ROOT, ".cert")


class Handler(http.server.SimpleHTTPRequestHandler):
    # Correct file types. Windows sometimes registers ".js" as text/plain,
    # and browsers refuse to run JavaScript modules served that way.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".task": "application/octet-stream",
    }

    def end_headers(self):
        # Never cache: after you edit a file, a simple reload shows the change.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet


def lan_ip():
    """IP address of this computer on the local network (what the phone must use)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))   # no packet is sent; it just picks a network card
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def make_certificate(ip):
    """Create (once) a self-signed HTTPS certificate valid for localhost and `ip`."""
    cert_file = os.path.join(CERT_DIR, f"cert-{ip}.pem")
    key_file = os.path.join(CERT_DIR, f"key-{ip}.pem")
    if os.path.exists(cert_file) and os.path.exists(key_file):
        return cert_file, key_file

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Forehead sensor guide (local)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName([
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.IPAddress(ipaddress.ip_address(ip)),
        ]), critical=False)
        .sign(key, hashes.SHA256())
    )
    os.makedirs(CERT_DIR, exist_ok=True)
    with open(key_file, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return cert_file, key_file


def serve(port, tls_context=None):
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), partial(Handler, directory=ROOT))
    if tls_context:
        server.socket = tls_context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


def main():
    ip = lan_ip()
    threading.Thread(target=serve, args=(HTTP_PORT,), daemon=True).start()
    print(f"\n  On this computer : http://localhost:{HTTP_PORT}")

    try:
        cert_file, key_file = make_certificate(ip)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_file, key_file)
        threading.Thread(target=serve, args=(HTTPS_PORT, context), daemon=True).start()
        print(f"  On your phone    : https://{ip}:{HTTPS_PORT}   (same Wi-Fi; accept the warning)")
    except ImportError:
        print("  (No HTTPS for the phone: run  pip install cryptography  and restart.)")

    print("\n  Press Ctrl+C to stop.\n")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
