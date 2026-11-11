"""Ende-zu-Ende ohne Telegram: echtes Gateway-Plugin (Node, makeHandler + callSocket) -> echter Freigabe-Socket (runner_daemon) -> Runner.
Belegt: Freigabe nur fuer Betreiber im privaten Chat, einmalig, an Version gebunden; Steuer-Socket kennt keine Freigabe; root-Bestaetigung per SO_PEERCRED."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runner"))
import runner_daemon  # noqa: E402
from tests.test_runner import OP, Base  # noqa: E402

PLUGIN = os.path.join(os.path.dirname(__file__), "..", "plugins", "gtads-freigabe", "index.mjs")
NODE = os.environ.get("GTADS_NODE") or shutil.which("node")


@unittest.skipUnless(NODE, "node nicht vorhanden (GTADS_NODE setzen)")
class PluginSocketE2E(Base):
    def setUp(self):
        super().setUp()
        self.sock = os.path.join(tempfile.mkdtemp(dir="/tmp"), "approve.sock")
        self.srv = runner_daemon.open_socket(self.sock, runner_daemon.ApproveHandler, 0o600, None, self.runner)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.shutdown)

    def press(self, action, sender=OP, chat=OP, group=False, nonce=None):
        script = """
import { makeHandler } from %s;
const replies = [];
const ctx = { senderId: %s, isGroup: %s, isForum: false, callback: { namespace: "gtr", payload: %s, chatId: %s },
  respond: { reply: async (r) => replies.push(r.text), clearButtons: async () => {} } };
await makeHandler({ operatorId: %s, runnerApproveSocket: %s })(ctx);
console.log(JSON.stringify(replies));
""" % (json.dumps("file://" + os.path.abspath(PLUGIN)), json.dumps(sender), "true" if group else "false",
       json.dumps("%s:%s" % (action, nonce or self.notifier.last_nonce())), json.dumps(chat), json.dumps(OP), json.dumps(self.sock))
        out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def test_operator_click_approves_once(self):
        self.runner.prepare("WP-X")
        self.assertIn("freigegeben", self.press("a")[0])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "approved")
        self.assertIn("bereits verwendet", self.press("a")[0])

    def test_foreign_and_group_clicks_change_nothing_but_are_logged(self):
        self.runner.prepare("WP-X")
        self.assertEqual(self.press("a", sender="123456"), [])
        self.assertEqual(self.press("a", chat="-100777", group=True), [])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")
        self.assertGreaterEqual(len([h for h in self.runner.approvals.history() if "abgelehnt" in h["event"]]), 2)
        self.assertIn("freigegeben", self.press("a")[0])

    def test_changed_spec_invalidates(self):
        self.runner.prepare("WP-X")
        with open(self.spec, "w") as handle:
            handle.write("v2")
        self.assertIn("nicht mehr offen", self.press("a")[0])

    def test_strong_confirm_rejected_for_non_root_peer(self):
        self.cfg["packages"]["WP-X"]["sensitive"] = True
        job = self.runner.prepare("WP-X")["job_id"]
        self.assertIn("SENSIBEL", self.press("a")[0])
        import socket
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(self.sock)
            s.sendall((json.dumps({"cmd": "strong_confirm", "subject": "job:%d" % job}) + "\n").encode())
            reply = json.loads(s.makefile().readline())
        self.assertFalse(reply["ok"])                     # dieser Testprozess ist nicht root
        self.assertIn("root", reply["error"])
        self.assertEqual(self.runner.status()["jobs"][0]["state"], "prepared")

    def test_control_socket_has_no_approval_commands(self):
        src = open(os.path.join(os.path.dirname(runner_daemon.__file__), "runner_daemon.py")).read()
        control = src[src.index("class Handler"):src.index("class Server")]
        self.assertNotIn('"button"', control)
        self.assertNotIn("strong_confirm", control)
        self.assertNotIn('cmd == "approve"', control)


if __name__ == "__main__":
    unittest.main()


class PlannerDaemonE2E(unittest.TestCase):
    """Planer-Dienst ueber echte Sockets: Steuer-Socket ohne Freigabe/Inhalte, Freigabe-Socket nur per Plugin-Nonce."""

    def setUp(self):
        import time
        import planner_daemon
        from tests.test_planner import FakeCodex, Gate, pkg, SECRET_TASK
        from planner_core import Planner
        from tests.test_runner import FakeNotifier
        self.SECRET = SECRET_TASK
        self.tmp = tempfile.mkdtemp(dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        os.makedirs(os.path.join(self.tmp, "rel"))
        self.notifier = FakeNotifier()
        cfg = {"db_path": os.path.join(self.tmp, "p.sqlite"), "operator_chat_id": OP, "release_dir": os.path.join(self.tmp, "rel"),
               "socket_path": os.path.join(self.tmp, "c.sock"), "approve_socket_path": os.path.join(self.tmp, "a.sock")}
        self.cfg = cfg
        self.planner = Planner(cfg, self.notifier, FakeCodex([pkg("Demo A")]), Gate())
        threading.Thread(target=planner_daemon.serve, args=(cfg, self.planner), daemon=True).start()
        for _ in range(100):
            if os.path.exists(cfg["approve_socket_path"]) and os.path.exists(cfg["socket_path"]):
                break
            time.sleep(0.05)

    def call(self, sock, payload):
        import mcp_server
        return mcp_server.call_runner(payload, sock)

    def wait_idle(self):
        import time
        for _ in range(200):
            if self.planner.busy.acquire(blocking=False):
                self.planner.busy.release()
                return
            time.sleep(0.01)

    def test_control_socket_plans_lists_metadata_and_cannot_approve(self):
        self.assertTrue(self.call(self.cfg["socket_path"], {"cmd": "plan_request", "count": 1})["ok"])
        self.wait_idle()
        listing = self.call(self.cfg["socket_path"], {"cmd": "plan_list"})
        self.assertEqual(listing["result"]["entwuerfe"][0]["id"], "CX-001")
        self.assertNotIn(self.SECRET, json.dumps(listing))
        for cmd in ("button", "strong_confirm", "approve", "release"):
            self.assertFalse(self.call(self.cfg["socket_path"], {"cmd": cmd, "nonce": self.notifier.last_nonce(), "action": "a",
                                                                  "sender_id": OP, "chat_id": OP, "is_group": False, "subject": "CX-001"})["ok"])
        self.assertEqual(os.listdir(os.path.join(self.tmp, "rel")), [])

    @unittest.skipUnless(NODE, "node nicht vorhanden")
    def test_plugin_click_releases_via_approve_socket(self):
        self.call(self.cfg["socket_path"], {"cmd": "plan_request", "count": 1})
        self.wait_idle()
        nonce = self.notifier.last_nonce()
        script = """
import { makeHandler } from %s;
const replies = [];
const ctx = { senderId: %s, isGroup: false, isForum: false, callback: { namespace: "gtp", payload: %s, chatId: %s },
  respond: { reply: async (r) => replies.push(r.text), clearButtons: async () => {} } };
await makeHandler({ operatorId: %s, plannerApproveSocket: %s })(ctx);
console.log(JSON.stringify(replies));
""" % (json.dumps("file://" + os.path.abspath(PLUGIN)), json.dumps(OP), json.dumps("a:" + nonce), json.dumps(OP), json.dumps(OP), json.dumps(self.cfg["approve_socket_path"]))
        out = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
        self.assertIn("Freigegeben", out.stdout, out.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "rel", "CX-001", "v1.json")))
