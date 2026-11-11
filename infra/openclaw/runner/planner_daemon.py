"""Codex-Planer-Dienst (Benutzer ocplan): Steuer-Socket (Metadaten, Planungsauftraege) + Freigabe-Socket (Schaltflaechen, root-Bestaetigung).
Lauscht NUR auf Unix-Sockets. Der Planungsbereich (DB, Prompts, OpenClaw-Zustand mit Codex-Anmeldung) ist 0700 und gehoert ocplan."""

import json
import os
import socketserver
import sys
import threading

from quota import QuotaGate
from runner_daemon import ApproveHandler, open_socket
from planner_core import Planner, PlannerError


class ControlHandler(socketserver.StreamRequestHandler):
    """Steuer-Socket fuer den Statusagenten (MCP): KEINE Freigabe, KEINE Entwurfsinhalte."""

    def handle(self):
        planner = self.server.target
        try:
            req = json.loads(self.rfile.readline(8192).decode("utf-8"))
            cmd = req.get("cmd")
            if cmd == "plan_request":
                result = planner.request(req.get("count", 3), str(req.get("hint") or ""))
            elif cmd == "plan_revise":
                result = planner.request(1, target=str(req.get("draft_id") or ""), revise_note=str(req.get("note") or ""))
            elif cmd == "plan_list":
                result = planner.list()
            elif cmd == "plan_cancel":
                result = planner.cancel()
            elif cmd == "plan_health":
                result = planner.health()
            elif cmd == "plan_limits":
                # blockiert nie: letzte Messung (Hintergrundmessung, falls aelter als 15 min). Der Start von Codex misst immer frisch.
                result = planner.gate.cached() if planner.gate is not None else {"allowed": False, "reason": "kein Gate"}
            else:
                raise PlannerError("Unbekannter Befehl.")
            reply = {"ok": True, "result": result}
        except PlannerError as exc:
            reply = {"ok": False, "error": str(exc)}
        except Exception:
            reply = {"ok": False, "error": "Interner Fehler im Planer."}
        try:
            self.wfile.write((json.dumps(reply, ensure_ascii=False) + "\n").encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            pass


def serve(cfg, planner):
    control = open_socket(cfg["socket_path"], ControlHandler, 0o660, cfg.get("socket_group"), planner, (PlannerError,))
    approve = open_socket(cfg["approve_socket_path"], ApproveHandler, 0o660, cfg.get("socket_group"), planner, (PlannerError,))
    threading.Thread(target=approve.serve_forever, daemon=True).start()
    control.serve_forever()


def main():
    from executors import CodexPlanner
    from notifier import TelegramNotifier
    with open(sys.argv[1], encoding="utf-8") as handle:
        cfg = json.load(handle)
    cred = os.environ["CREDENTIALS_DIRECTORY"]
    notifier = TelegramNotifier(os.path.join(cred, "telegram_bot_token"), cfg["operator_chat_id"])
    env = {"PATH": "/usr/bin:/bin", "HOME": cfg["home"], "OPENCLAW_STATE_DIR": cfg["home"] + "/.openclaw",
           "OPENCLAW_CONFIG_PATH": cfg["home"] + "/.openclaw/openclaw.json", "HTTPS_PROXY": "http://127.0.0.1:3128", "HTTP_PROXY": "http://127.0.0.1:3128",
           "NODE_USE_ENV_PROXY": "1", "NO_PROXY": "127.0.0.1,localhost,::1", "OPENCLAW_DISABLE_BONJOUR": "1", "CI": "1",
           "NODE_OPTIONS": "--max-old-space-size=1536"}  # Node raeumt vor der Dienstgrenze (3G) selbst auf
    codex = CodexPlanner(cfg, env)
    q = cfg.get("quota") or {}
    gate = QuotaGate(cfg["db_path"], codex.fetch_usage, {k: q[k] for k in ("limit_percent", "safety_margin_percent") if k in q})
    serve(cfg, Planner(cfg, notifier, codex, gate))


if __name__ == "__main__":
    main()
