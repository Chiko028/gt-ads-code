"""Coding-Runner-Dienst: Steuer-Socket (JSON-Zeilen) + Worker-Schleife. Lauscht NUR auf einem Unix-Socket."""

import json
import os
import socket
import socketserver
import sys
import threading
import time

from gemini_review import GeminiLimiter, GeminiReviewer
from quota import QuotaGate
from review_core import ReviewError, ReviewManager
from runner_core import Runner, RunnerError, Store


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        runner = self.server.runner
        try:
            line = self.rfile.readline(65536)
            req = json.loads(line.decode("utf-8"))
            cmd = req.get("cmd")
            if cmd == "prepare":
                result = runner.prepare(req.get("wp_id"))
            elif cmd == "stop":
                result = runner.stop(int(req["job_id"]) if req.get("job_id") else None)
            elif cmd == "status":
                result = runner.status()
            elif cmd == "health":
                result = runner.health()
            elif cmd == "costs":
                result = runner.costs()
            elif cmd == "released":
                result = runner.released()
            elif cmd == "start_released":
                ids = req.get("ids")
                result = runner.start_released([str(i) for i in ids] if isinstance(ids, list) else None)
            elif cmd == "report":
                result = runner.report(int(req["job_id"]) if req.get("job_id") else None)
            elif cmd in ("limits", "reviews", "review_findings", "agents"):
                result = self.server.review_cmd(cmd, req)
            else:
                raise RunnerError("Unbekannter Befehl.")
            reply = {"ok": True, "result": result}
        except RunnerError as exc:
            reply = {"ok": False, "error": str(exc)}
        except Exception as exc:
            reply = {"ok": False, "error": "Interner Fehler im Runner."}
            try:
                from redact import redact
                runner.store.audit(None, "interner_fehler_steuerung", redact("%s: %s" % (type(exc).__name__, exc), 280))
            except Exception:
                pass
        try:
            self.wfile.write((json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            pass  # Client hat schon aufgelegt; kein Traceback im Journal


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def peer_uid(sock):
    """UID des verbundenen Prozesses laut Kernel (SO_PEERCRED); nicht faelschbar durch den Client."""
    import struct
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", creds)[1]


class ApproveHandler(socketserver.StreamRequestHandler):
    """Freigabe-Socket (getrennt vom Steuer-Socket): nur Schaltflaechen-Callbacks vom Gateway-Plugin und die root-Bestaetigung.
    Der MCP-Server (Sprachmodell-Werkzeuge) verbindet sich nie hierher; der Steuer-Socket kennt keine Freigabe-Befehle."""

    def handle(self):
        target = self.server.target
        try:
            req = json.loads(self.rfile.readline(4096).decode("utf-8"))
            cmd = req.get("cmd")
            if cmd == "button":
                result = target.button(str(req.get("nonce", "")), str(req.get("action", "")), req.get("sender_id"), req.get("chat_id"), bool(req.get("is_group", True)))
            elif cmd == "resend":
                result = target.resend(req.get("sender_id"), req.get("chat_id"), bool(req.get("is_group", True)))
            elif cmd == "strong_confirm":
                result = target.strong_confirm(str(req.get("subject", "")), peer_uid(self.connection))
            else:
                raise RunnerError("Unbekannter Befehl.")
            reply = {"ok": True, "result": result}
        except self.server.user_errors as exc:
            reply = {"ok": False, "error": str(exc)}
        except Exception:
            reply = {"ok": False, "error": "Interner Fehler."}
        try:
            self.wfile.write((json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            pass


def open_socket(path, handler, mode, group, target, user_errors=(RunnerError,)):
    if os.path.exists(path):
        os.unlink(path)
    srv = Server(path, handler)
    os.chmod(path, mode)
    if group:
        import grp
        os.chown(path, -1, grp.getgrnam(group).gr_gid)
    srv.target = target
    srv.user_errors = tuple(user_errors)
    return srv


def refresh_loop(gate, stop_event, interval=600):
    """Haelt die Kontingent-Messung warm, damit /limits sofort antwortet (die Messung selbst dauert bis zu 2 Minuten)."""
    while not stop_event.is_set():
        gate.refresh_async()
        stop_event.wait(interval)


def review_loop(manager, dev, rev, stop_event, interval=20):
    while not stop_event.is_set():
        try:
            manager.run_next(dev, rev)
        except Exception:
            pass  # nie abstuerzen; Zustand steht in der Datenbank
        stop_event.wait(interval)


def make_review_cmd(runner, manager, gate):
    def review_cmd(cmd, req):
        if manager is None:
            raise RunnerError("Codex-Reviews sind in der Runner-Konfiguration deaktiviert.")
        if cmd == "limits":
            return gate.cached()  # blockiert nie (die frische Messung dauert ueber 30 s und wuerde die Chat-Anfrage ins Zeitlimit laufen lassen)
        if cmd == "reviews":
            return {"reviews": manager.list(10)}
        if cmd == "review_findings":
            try:
                return {"review_id": int(req["review_id"]), "fundstellen": manager.findings(int(req["review_id"]))}
            except (ReviewError, KeyError, ValueError) as exc:
                raise RunnerError(str(exc) if isinstance(exc, ReviewError) else "review_id fehlt oder ist ungueltig")
        quota = gate.cached()
        status = runner.status()
        return {"deepseek": {"rolle": "Programmierer (Runner)", "laufender_auftrag": next((j for j in status["jobs"] if j["state"] == "running"), None),
                             "pakete": status["pakete"]},
                "codex": {"rolle": "Reviewer (nur lesend, ChatGPT-Abo, keine API)", "startbereit": quota["allowed"], "grund": quota["reason"], "plan": quota.get("plan")},
                "gemini": manager.gemini_status(),
                "openclaw": {"rolle": "Koordination, Telegram, Status", "zustand": "laeuft"}}
    return review_cmd


def worker_loop(runner, executor, stop_event):
    while not stop_event.is_set():
        job = runner.claim_next()
        if job is None:
            stop_event.wait(3)
            continue
        executor.stop_check = lambda jid=job["id"]: runner.stop_requested(jid)
        try:
            runner.execute(job, executor)
        except Exception as exc:  # nie den Worker verlieren: Auftrag als fehlgeschlagen abschliessen, Grund (bereinigt) melden
            from redact import redact
            reason = redact("%s: %s" % (type(exc).__name__, exc), 280)
            runner.store.audit(job["id"], "interner_fehler_worker", reason)
            try:
                runner._finish(job["id"], "failed", error="Interner Fehler: " + reason)
                runner.notifier.send_operator("Auftrag #%d: interner Fehler im Runner: %s" % (job["id"], reason))
            except Exception:
                pass


def serve(config, executor, notifier, sock_path, sock_group_mode=0o660, reviewer=None, gemini_key=""):
    runner = Runner(Store(config["db_path"]), config, notifier)
    runner.recover_after_restart()
    manager = gate = None
    rcfg = config.get("reviews") or {}
    if reviewer is not None and rcfg.get("enabled"):
        gate = QuotaGate(config["db_path"], reviewer.fetch_usage, {k: rcfg[k] for k in ("limit_percent", "safety_margin_percent") if k in rcfg})
        gcfg = config.get("gemini") or {}
        gemini = None
        if gcfg.get("enabled") and gemini_key.strip() and gcfg.get("model"):
            gemini = GeminiReviewer(gemini_key, gcfg["model"], GeminiLimiter(config["db_path"], {k: gcfg[k] for k in ("max_requests_per_day", "min_interval_s", "max_prompt_chars") if k in gcfg}))
        manager = ReviewManager(runner, gate, notifier, {"max_rounds": rcfg.get("max_rounds", 3)}, gemini=gemini)
        manager.recover_after_restart()
        runner.on_success = manager.enqueue
        runner.busy_check = manager.busy
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    server = Server(sock_path, Handler)
    os.chmod(sock_path, sock_group_mode)
    group = config.get("socket_group")
    if group:  # nur dieser Gruppe (OpenClaw-Dienst) Zugriff auf den Steuer-Socket
        import grp
        os.chown(sock_path, -1, grp.getgrnam(group).gr_gid)
    server.runner = runner
    server.review_cmd = make_review_cmd(runner, manager, gate)
    stop = threading.Event()
    if config.get("approve_socket_path"):
        approve_srv = open_socket(config["approve_socket_path"], ApproveHandler, 0o660, config.get("socket_group"), runner)
        threading.Thread(target=approve_srv.serve_forever, daemon=True).start()
    threading.Thread(target=worker_loop, args=(runner, executor, stop), daemon=True).start()
    if manager is not None:
        threading.Thread(target=review_loop, args=(manager, executor, reviewer, stop), daemon=True).start()
        threading.Thread(target=refresh_loop, args=(gate, stop), daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop.set()


def main():
    from executors import CodexReviewer, StackExecutor
    from notifier import TelegramNotifier
    with open(sys.argv[1], encoding="utf-8") as handle:
        config = json.load(handle)
    cred = os.environ["CREDENTIALS_DIRECTORY"]
    notifier = TelegramNotifier(os.path.join(cred, "telegram_bot_token"), config["operator_chat_id"])
    env = {"PATH": "/usr/bin:/bin", "HOME": config["home"], "XDG_RUNTIME_DIR": config["xdg_runtime_dir"],
           "OPENCLAW_STATE_DIR": config["home"] + "/.openclaw", "OPENCLAW_CONFIG_PATH": config["home"] + "/.openclaw/openclaw.json",
           "DEEPSEEK_API_KEY": open(os.path.join(cred, "deepseek_api_key"), encoding="utf-8").read().strip(),
           "HTTPS_PROXY": "http://127.0.0.1:3128", "HTTP_PROXY": "http://127.0.0.1:3128", "NODE_USE_ENV_PROXY": "1",
           "NO_PROXY": "127.0.0.1,localhost,::1", "OPENCLAW_DISABLE_BONJOUR": "1", "CI": "1"}
    key_path = os.path.join(cred, "gemini_api_key")
    gemini_key = open(key_path, encoding="utf-8").read() if os.path.exists(key_path) else ""
    serve(config, StackExecutor(config, env), notifier, config["socket_path"], reviewer=CodexReviewer(config, env), gemini_key=gemini_key)


if __name__ == "__main__":
    main()
