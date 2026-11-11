"""Minimaler MCP-Server (stdio, JSON-RPC, Zeilenformat) als duenne Bruecke zum Coding-Runner.
Wird vom OpenClaw-Gateway gestartet. Enthaelt KEINE Entscheidungslogik: Freigabe, Limits und Code-Pruefung liegen im Runner.
Freigaben sind hier NICHT moeglich (nur Telegram-Schaltflaechen ueber den getrennten Freigabe-Socket)."""

import json
import os
import socket
import sys

SOCK = os.environ.get("GTADS_RUNNER_SOCK", "/run/gtads-runner/control.sock")
PLANNER_SOCK = os.environ.get("GTADS_PLANNER_SOCK", "/run/gtads-planner/control.sock")
# Kategorien (Betreiber 2026-11-11): Information | Entwurf | Ausfuehrung freigegebener Pakete | Stopp. FREIGABE gibt es hier bewusst NICHT:
# sie geht nur ueber Telegram-Schaltflaechen (Plugin gtads-freigabe -> Freigabe-Sockets). Normale Nachrichten koennen nichts freigeben.

TOOLS = [
    {"name": "coder_prepare", "description": "Bereitet einen Programmierauftrag fuer ein Arbeitspaket zur Freigabe vor. Startet NICHTS. Die Freigabe-Anfrage mit Schaltflaechen geht direkt an den Betreiber; freigeben kann nur er per Schaltflaeche.",
     "inputSchema": {"type": "object", "properties": {"wp_id": {"type": "string", "description": "Arbeitspaket-ID, z. B. WP-009"}}, "required": ["wp_id"]}},
    {"name": "coder_stop", "description": "Stoppt den laufenden Auftrag (nur auf ausdrueckliche Bitte des Betreibers).",
     "inputSchema": {"type": "object", "properties": {"job_id": {"type": "integer"}}}},
    {"name": "coder_status", "description": "Zeigt Aufträge, Verbrauch und freigegebene Pakete des Coding-Runners.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "coder_limits", "description": "Zeigt das tatsaechlich gemessene Codex-Kontingent (5-Stunden- und Wochenfenster) und ob automatische Reviews starten duerfen. Nie schaetzen: ist es nicht messbar, wird das gemeldet.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "coder_reviews", "description": "Zeigt wartende, pausierte (mit Grund), laufende und abgeschlossene Codex-Reviews.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "coder_review_findings", "description": "Zeigt die Fundstellen eines Reviews (Datei, Zeile, Beleg, ob bei der Pruefung bestaetigt).", "inputSchema": {"type": "object", "properties": {"review_id": {"type": "integer"}}, "required": ["review_id"]}},
    {"name": "coder_agents", "description": "Status der Agenten: DeepSeek (Programmierer), Codex (Reviewer), Gemini (optional), OpenClaw.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "coder_report", "description": "Zeigt den Bericht eines beendeten Auftrags inkl. Grund und letzter Versuche (z. B. 'Warum ist X blockiert?').", "inputSchema": {"type": "object", "properties": {"job_id": {"type": "integer"}}}},
    {"name": "coder_released", "description": "INFORMATION: Listet die vom Betreiber per Schaltflaeche freigegebenen Codex-Pakete (ID, Version, Titel, Hash) und ob/wie sie bearbeitet wurden.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "coder_start_released", "description": "AUSFUEHRUNG: Reiht freigegebene Codex-Pakete fuer DeepSeek ein (nur bereits freigegebene Versionen; nacheinander; Abhaengigkeiten beachtet). Nur auf ausdrueckliche Bitte des Betreibers, z. B. 'DeepSeek, starte die freigegebenen Aufgaben'. Gibt NICHTS frei.",
     "inputSchema": {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}, "description": "optional, z. B. [\"CX-001\"]; leer = alle freigegebenen"}}}},
    {"name": "codex_plan", "description": "ENTWURF: Codex bereitet die naechsten Arbeitspakete vor (nur wenn das Codex-Kontingent zuverlaessig unter 80 % liegt). Die Entwuerfe gehen mit Schaltflaechen direkt an den Betreiber; freigeben kann nur er.",
     "inputSchema": {"type": "object", "properties": {"count": {"type": "integer", "minimum": 1, "maximum": 5}, "hint": {"type": "string"}}}},
    {"name": "codex_revise", "description": "ENTWURF: Codex ueberarbeitet einen Entwurf (neue Version; die alte Freigabe-Anfrage wird ungueltig, die neue erscheint erneut zur Freigabe).",
     "inputSchema": {"type": "object", "properties": {"draft_id": {"type": "string"}, "note": {"type": "string"}}, "required": ["draft_id", "note"]}},
    {"name": "coder_health", "description": "DIAGNOSE (nur lesend): Laeuft der Runner, ist der Proxy erreichbar, welcher Auftrag laeuft seit wann (letzte Versuche), letzte Fehler mit Grund (bereinigt). Fuer 'Was ist los?', 'Warum haengt es?'.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "coder_costs", "description": "INFORMATION: DeepSeek-Kosten gesamt, letzte 24 h, je Paket und Rest des Pilotbudgets.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "codex_health", "description": "DIAGNOSE (nur lesend): Codex-Planer - laufende Planung seit wann, wartende Entwuerfe, letzte Fehler mit Grund.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "codex_cancel", "description": "STOPP: Bricht die laufende Codex-Planung ab (z. B. 'Stoppe die Codex-Planung' oder 'Stoppe alles'). Gibt nichts frei.", "inputSchema": {"type": "object", "properties": {}}},
    {"name": "codex_drafts", "description": "INFORMATION: Welche Codex-Entwuerfe warten auf Freigabe? Nur Metadaten (ID, Titel, Status, Hash); Inhalte sieht nur der Betreiber ueber 'Details'.", "inputSchema": {"type": "object", "properties": {}}},
]
CMD = {"coder_prepare": "prepare", "coder_stop": "stop", "coder_status": "status", "coder_report": "report",
       "coder_limits": "limits", "coder_reviews": "reviews", "coder_review_findings": "review_findings", "coder_agents": "agents",
       "coder_released": "released", "coder_start_released": "start_released", "coder_health": "health", "coder_costs": "costs"}
PLANNER_CMD = {"codex_plan": "plan_request", "codex_revise": "plan_revise", "codex_drafts": "plan_list", "codex_health": "plan_health", "codex_cancel": "plan_cancel"}


def call_runner(payload, sock_path=None):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(30)
        sock.connect(sock_path or SOCK)
        sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
        data = b""
        while not data.endswith(b"\n") and len(data) < 1_000_000:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data.decode("utf-8"))


def handle(msg, sock_path=None):
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # Notification
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "gtads-coder", "version": "1.0"}}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = msg.get("params", {})
        name, args = params.get("name"), params.get("arguments") or {}
        if name not in CMD and name not in PLANNER_CMD:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unbekanntes Werkzeug"}}
        try:
            if name in PLANNER_CMD:
                reply = call_runner(dict(args, cmd=PLANNER_CMD[name]), PLANNER_SOCK if sock_path is None else sock_path + ".planner")
            else:
                reply = call_runner(dict(args, cmd=CMD[name]), sock_path)
            text, is_error = json.dumps(reply.get("result") if reply.get("ok") else {"fehler": reply.get("error")}, ensure_ascii=False), not reply.get("ok")
        except socket.timeout:
            text, is_error = json.dumps({"fehler": "Keine Antwort innerhalb von 30 s (Dienst beschaeftigt). Nicht wiederholen; Status spaeter abfragen."}), True
        except Exception:
            text, is_error = json.dumps({"fehler": "Dienst nicht erreichbar."}), True
        return {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}], "isError": is_error}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": mid, "result": {}}
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Methode nicht unterstuetzt"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            reply = handle(json.loads(line))
        except Exception:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
