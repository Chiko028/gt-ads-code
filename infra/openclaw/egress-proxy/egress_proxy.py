"""Allowlist-Egress-Proxy für OpenClaw (nur Python-Standardbibliothek).

Zweck: Der OpenClaw-Dienst darf per systemd nur noch Loopback ansprechen (IPAddressDeny=any). Der einzige Weg
ins Internet führt über diesen Proxy, der **nur** `CONNECT` zu freigegebenen Hostnamen auf freigegebenen Ports
erlaubt. Alles andere wird abgelehnt. Kein TLS-Aufbrechen (die Verbindung wird nur durchgereicht).

Schutzmaßnahmen: keine IP-Literale, keine Wildcards, keine privaten/loopback/link-local Zieladressen nach der
Namensauflösung (Schutz vor DNS-Rebinding auf interne Ziele), Header-Größenlimit, Verbindungslimit, Zeitlimits.
Logs enthalten nur Metadaten (erlaubt/abgelehnt, Host, Port, Grund, Bytes), nie Inhalte.
"""

import argparse
import ipaddress
import logging
import re
import select
import socket
import socketserver
import sys
import threading
import time

LOG = logging.getLogger("gtads_egress")
MAX_HEADER_BYTES = 8192
CONNECT_TIMEOUT_S = 10
IDLE_TIMEOUT_S = 120
DEFAULT_PORTS = frozenset({443})
_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


def load_allowlist(path):
    """Liest Hostnamen (eine pro Zeile, `#` Kommentare). Keine Wildcards, keine IPs."""
    hosts = set()
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.split("#", 1)[0].strip().lower()
            if not line:
                continue
            if not _HOST_RE.match(line) or is_ip_literal(line) or not re.search(r"[a-z]", line.rsplit(".", 1)[1]):
                raise ValueError("ungültiger Allowlist-Eintrag (nur vollständige Hostnamen, keine Wildcards/IPs)")
            hosts.add(line)
    if not hosts:
        raise ValueError("Allowlist ist leer")
    return frozenset(hosts)


def normalize_host(host):
    host = host.strip().lower().rstrip(".")
    return host


def is_ip_literal(host):
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


def is_forbidden_address(address):
    ip = ipaddress.ip_address(address)
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
            or ip.is_unspecified)


def safe_label(text):
    """Begrenzte, unkritische Darstellung für Logs."""
    cleaned = re.sub(r"[^a-z0-9.\-]", "?", str(text).lower())
    return cleaned[:100]


def default_resolver(host, port):
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, allowlist, ports=DEFAULT_PORTS, max_connections=64, resolver=default_resolver,
                 connector=None, allow_private=False, connect_timeout=CONNECT_TIMEOUT_S, idle_timeout=IDLE_TIMEOUT_S):
        self.allowlist = frozenset(allowlist)
        self.ports = frozenset(ports)
        self.slots = threading.BoundedSemaphore(max_connections)
        self.resolver = resolver
        self.connector = connector or self._connect
        self.allow_private = allow_private  # nur für Tests; nicht über die CLI erreichbar
        self.connect_timeout = connect_timeout
        self.idle_timeout = idle_timeout
        super().__init__(address, Handler)

    def _connect(self, host, port):
        last = None
        for address in self.resolver(host, port):
            if not self.allow_private and is_forbidden_address(address):
                last = "private_address"
                continue
            try:
                return socket.create_connection((address, port), timeout=self.connect_timeout), None
            except OSError:
                last = "connect_failed"
        return None, last or "no_address"


class Handler(socketserver.BaseRequestHandler):
    def _reply(self, status, text):
        try:
            self.request.sendall(("HTTP/1.1 %d %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" % (status, text)).encode("ascii"))
        except OSError:
            pass

    def _read_head(self):
        data = b""
        self.request.settimeout(10)
        while b"\r\n\r\n" not in data:
            if len(data) > MAX_HEADER_BYTES:
                return None
            chunk = self.request.recv(2048)
            if not chunk:
                return None
            data += chunk
        return data

    def handle(self):
        server = self.server
        if not server.slots.acquire(blocking=False):
            LOG.info("denied reason=too_many_connections")
            self._reply(503, "Service Unavailable")
            return
        try:
            self._serve(server)
        finally:
            server.slots.release()

    def _serve(self, server):
        try:
            head = self._read_head()
        except OSError:
            return
        if head is None:
            LOG.info("denied reason=bad_request")
            self._reply(400, "Bad Request")
            return
        first = head.split(b"\r\n", 1)[0].decode("latin1", "replace")
        parts = first.split(" ")
        if len(parts) != 3 or not parts[2].startswith("HTTP/"):
            LOG.info("denied reason=bad_request")
            self._reply(400, "Bad Request")
            return
        method, target = parts[0], parts[1]
        if method.upper() != "CONNECT":
            LOG.info("denied reason=method_not_allowed")
            self._reply(405, "Method Not Allowed")
            return
        host_part, _, port_part = target.rpartition(":")
        host = normalize_host(host_part)
        if not host or not port_part.isdigit() or len(port_part) > 5:
            LOG.info("denied reason=bad_target")
            self._reply(400, "Bad Request")
            return
        port = int(port_part)
        label = "host=%s port=%d" % (safe_label(host), port)
        if is_ip_literal(host):
            LOG.info("denied reason=ip_literal %s", label)
            self._reply(403, "Forbidden")
            return
        if host not in server.allowlist:
            LOG.info("denied reason=host_not_allowed %s", label)
            self._reply(403, "Forbidden")
            return
        if port not in server.ports:
            LOG.info("denied reason=port_not_allowed %s", label)
            self._reply(403, "Forbidden")
            return
        upstream, reason = server.connector(host, port)
        if upstream is None:
            LOG.info("denied reason=%s %s", reason or "connect_failed", label)
            self._reply(403 if reason == "private_address" else 502, "Forbidden" if reason == "private_address" else "Bad Gateway")
            return
        try:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            up, down = self._relay(self.request, upstream, server.idle_timeout)
            LOG.info("allowed %s up=%d down=%d", label, up, down)
        finally:
            upstream.close()

    @staticmethod
    def _relay(client, upstream, idle_timeout):
        up = down = 0
        sockets = [client, upstream]
        last = time.monotonic()
        client.settimeout(None)
        upstream.settimeout(None)
        while True:
            ready, _, _ = select.select(sockets, [], [], 5)
            if not ready:
                if time.monotonic() - last > idle_timeout:
                    break
                continue
            for sock in ready:
                try:
                    data = sock.recv(16384)
                except OSError:
                    return up, down
                if not data:
                    return up, down
                last = time.monotonic()
                try:
                    if sock is client:
                        upstream.sendall(data)
                        up += len(data)
                    else:
                        client.sendall(data)
                        down += len(data)
                except OSError:
                    return up, down
        return up, down


def main(argv=None):
    parser = argparse.ArgumentParser(description="GT-Ads Egress-Allowlist-Proxy (nur CONNECT)")
    parser.add_argument("--listen", default="127.0.0.1:3128", help="nur Loopback erlaubt")
    parser.add_argument("--allowlist", default="/etc/gt-ads/egress-allowlist.txt")
    parser.add_argument("--max-connections", type=int, default=64)
    args = parser.parse_args(argv)
    host, _, port = args.listen.rpartition(":")
    if host not in ("127.0.0.1", "::1", "localhost"):
        print("Startfehler: --listen muss Loopback sein", file=sys.stderr)
        return 2
    try:
        allowlist = load_allowlist(args.allowlist)
    except (OSError, ValueError) as error:
        print("Startfehler: %s" % error, file=sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", stream=sys.stdout)
    server = ProxyServer((host, int(port)), allowlist, max_connections=max(1, min(args.max_connections, 256)))
    LOG.info("startup listen=%s hosts=%d", safe_label(args.listen), len(allowlist))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
