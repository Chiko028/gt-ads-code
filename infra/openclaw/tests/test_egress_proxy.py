"""Tests für den Egress-Proxy: nur lokale Sockets (127.0.0.1), kein Zugriff auf das Internet."""

import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "egress-proxy"))
import egress_proxy as ep  # noqa: E402


class EchoServer:
    """Lokaler „Upstream“: antwortet mit dem Gesendeten, in Großbuchstaben."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    @staticmethod
    def _serve(conn):
        try:
            while True:
                data = conn.recv(4096)
                if not data:
                    return
                conn.sendall(data.upper())
        except OSError:
            pass
        finally:
            conn.close()

    def close(self):
        self.sock.close()


def start_proxy(allowlist, upstream_port=None, **kwargs):
    kwargs.setdefault("allow_private", True)  # Test-Upstream liegt auf Loopback
    resolver = kwargs.pop("resolver", lambda host, port: ["127.0.0.1"])
    ports = kwargs.pop("ports", {upstream_port} if upstream_port else ep.DEFAULT_PORTS)
    server = ep.ProxyServer(("127.0.0.1", 0), allowlist, ports=ports, resolver=resolver, **kwargs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def request(server, payload, read_all=True):
    sock = socket.create_connection(server.server_address, timeout=5)
    sock.sendall(payload)
    sock.settimeout(5)
    data = b""
    try:
        while b"\r\n\r\n" not in data:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except OSError:
        pass
    return sock, data


def status_of(data):
    return int(data.split(b" ", 2)[1]) if data.startswith(b"HTTP/") else 0


class EgressProxyTests(unittest.TestCase):
    def setUp(self):
        self.echo = EchoServer()
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        self.echo.close()

    def proxy(self, allowlist=("api.allowed.test",), **kwargs):
        server = start_proxy(allowlist, self.echo.port, **kwargs)
        self.servers.append(server)
        return server

    def test_allowed_host_is_tunnelled(self):
        server = self.proxy()
        sock, head = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\nHost: x\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head), 200)
        sock.sendall(b"hallo")
        self.assertEqual(sock.recv(100), b"HALLO")
        sock.close()

    def test_host_matching_is_case_and_trailing_dot_insensitive(self):
        server = self.proxy()
        sock, head = request(server, ("CONNECT API.Allowed.TEST.:%d HTTP/1.1\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head), 200)
        sock.close()

    def test_denied_cases(self):
        server = self.proxy()
        p = self.echo.port
        cases = {
            "fremder Host": ("CONNECT evil.test:%d HTTP/1.1\r\n\r\n" % p, 403),
            "Teilstring-Trick": ("CONNECT api.allowed.test.evil.test:%d HTTP/1.1\r\n\r\n" % p, 403),
            "Unterdomain": ("CONNECT x.api.allowed.test:%d HTTP/1.1\r\n\r\n" % p, 403),
            "IP-Literal": ("CONNECT 127.0.0.1:%d HTTP/1.1\r\n\r\n" % p, 403),
            "IPv6-Literal": ("CONNECT [::1]:%d HTTP/1.1\r\n\r\n" % p, 403),
            "falscher Port": ("CONNECT api.allowed.test:80 HTTP/1.1\r\n\r\n", 403),
            "kein CONNECT (GET)": ("GET http://api.allowed.test/ HTTP/1.1\r\nHost: api.allowed.test\r\n\r\n", 405),
            "kaputte Zeile": ("QUATSCH\r\n\r\n", 400),
            "Port keine Zahl": ("CONNECT api.allowed.test:abc HTTP/1.1\r\n\r\n", 400),
            "ohne Port": ("CONNECT api.allowed.test HTTP/1.1\r\n\r\n", 400),
        }
        for name, (payload, expected) in cases.items():
            with self.subTest(name):
                sock, head = request(server, payload.encode())
                self.assertEqual(status_of(head), expected, head[:60])
                sock.close()

    def test_oversized_header_is_rejected(self):
        server = self.proxy()
        sock, head = request(server, b"CONNECT api.allowed.test:443 HTTP/1.1\r\n" + b"X: " + b"a" * 20000)
        self.assertEqual(status_of(head), 400)
        sock.close()

    def test_private_resolution_is_blocked_unless_test_mode(self):  # DNS-Rebinding-Schutz
        server = self.proxy(allow_private=False, resolver=lambda h, p: ["10.1.2.3"])
        sock, head = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head), 403)
        sock.close()
        for addr in ("127.0.0.1", "169.254.169.254", "192.168.0.1", "172.16.0.5", "::1", "fe80::1", "0.0.0.0", "224.0.0.1"):
            self.assertTrue(ep.is_forbidden_address(addr), addr)
        self.assertFalse(ep.is_forbidden_address("93.184.216.34"))

    def test_connection_limit(self):
        server = self.proxy(max_connections=1)
        sock1, head1 = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head1), 200)
        sock2, head2 = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head2), 503)
        sock1.close()
        sock2.close()

    def test_upstream_failure_is_bad_gateway(self):
        server = self.proxy(connector=lambda h, p: (None, "connect_failed"))
        sock, head = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head), 502)
        sock.close()

    def test_idle_connection_is_closed(self):
        server = self.proxy(idle_timeout=1)
        sock, head = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\n\r\n" % self.echo.port).encode())
        self.assertEqual(status_of(head), 200)
        sock.settimeout(8)
        self.assertEqual(sock.recv(10), b"")  # Proxy schließt nach Leerlauf
        sock.close()

    def test_logs_contain_metadata_only(self):
        server = self.proxy()
        with self.assertLogs("gtads_egress", level="INFO") as logs:
            sock, head = request(server, ("CONNECT api.allowed.test:%d HTTP/1.1\r\nAuthorization: Bearer GEHEIM123\r\n\r\n" % self.echo.port).encode())
            sock.sendall(b"nutzdaten-GEHEIM")
            sock.recv(100)
            sock.close()
            sock2, _ = request(server, b"CONNECT evil\xc3\xa4.test:443 HTTP/1.1\r\n\r\n")
            sock2.close()
            import time
            time.sleep(0.3)
        text = "\n".join(logs.output)
        self.assertNotIn("GEHEIM", text)
        self.assertIn("allowed host=api.allowed.test", text)
        self.assertIn("denied reason=host_not_allowed", text)

    def test_allowlist_loading(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.txt")
            with open(path, "w") as handle:
                handle.write("# Kommentar\napi.telegram.org  # Telegram\n\nAPI.DEEPSEEK.COM\n")
            self.assertEqual(ep.load_allowlist(path), frozenset({"api.telegram.org", "api.deepseek.com"}))
            for bad in ("*.telegram.org\n", ".telegram.org\n", "10.0.0.1\n", "localhost\n", "a b.c\n", "\n# nur Kommentar\n", "https://x.test\n"):
                with self.subTest(bad=bad):
                    with open(path, "w") as handle:
                        handle.write(bad)
                    with self.assertRaises(ValueError):
                        ep.load_allowlist(path)

    def test_cli_requires_loopback_and_allowlist(self):
        self.assertEqual(ep.main(["--listen", "0.0.0.0:3128", "--allowlist", "/nicht/da"]), 2)
        self.assertEqual(ep.main(["--listen", "127.0.0.1:3128", "--allowlist", "/nicht/da"]), 2)


if __name__ == "__main__":
    unittest.main()
