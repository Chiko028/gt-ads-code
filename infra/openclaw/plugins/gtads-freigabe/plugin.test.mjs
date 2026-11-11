// node --test plugin.test.mjs  (deterministische Pruefung des Handlers ohne Gateway)
import test from "node:test";
import assert from "node:assert/strict";
import { makeHandler } from "./index.mjs";

const OP = "789682954";
const N = "A".repeat(22);
function ctx(over = {}) {
  const out = { replies: [], cleared: 0 };
  const c = {
    senderId: OP, isGroup: false, isForum: false, threadId: undefined,
    callback: { namespace: "gtr", payload: "a:" + N, chatId: OP },
    respond: { reply: async (r) => out.replies.push(r.text), clearButtons: async () => { out.cleared++; } },
    ...over,
  };
  return { c, out };
}
function fakeCall(result = { ok: true, result: { text: "Auftrag #1 freigegeben." } }) {
  const calls = [];
  return { calls, call: async (path, req) => { calls.push({ path, req }); return result; } };
}

test("Betreiber im privaten Chat: Anfrage an Runner-Socket, Knoepfe entfernt", async () => {
  const f = fakeCall();
  const { c, out } = ctx();
  await makeHandler({ operatorId: OP }, f.call)(c);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/run/gtads-runner/approve.sock");
  assert.deepEqual(f.calls[0].req, { cmd: "button", nonce: N, action: "a", sender_id: OP, chat_id: OP, is_group: false });
  assert.equal(out.cleared, 1);
  assert.deepEqual(out.replies, ["Auftrag #1 freigegeben."]);
});

test("Planer-Namensraum geht an den Planer-Socket", async () => {
  const f = fakeCall();
  await makeHandler({ operatorId: OP }, f.call)(ctx({ callback: { namespace: "gtp", payload: "r:" + N, chatId: OP } }).c);
  assert.equal(f.calls[0].path, "/run/gtads-planner/approve.sock");
  assert.equal(f.calls[0].req.action, "r");
});

for (const [name, over] of [
  ["fremder Absender", { senderId: "111111" }],
  ["Gruppe", { isGroup: true, callback: { namespace: "gtr", payload: "a:" + N, chatId: "-100555" } }],
  ["anderer Chat", { callback: { namespace: "gtr", payload: "a:" + N, chatId: "-100555" } }],
  ["Forum-Thema", { isForum: true }],
  ["ohne Absender", { senderId: undefined }],
]) {
  test("abgelehnt: " + name + " (nichts angezeigt, Socket bekommt is_group=true nur zum Protokollieren)", async () => {
    const f = fakeCall();
    const { c, out } = ctx(over);
    await makeHandler({ operatorId: OP }, f.call)(c);
    assert.deepEqual(out.replies, []);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].req.is_group, true);
  });
}

test("ungueltige Nutzdaten erreichen keinen Socket", async () => {
  for (const payload of ["a:kurz", "x:" + N, "a:" + N + "x", "a:../../etc/passwd....", ""]) {
    const f = fakeCall();
    await makeHandler({ operatorId: OP }, f.call)(ctx({ callback: { namespace: "gtr", payload, chatId: OP } }).c);
    assert.equal(f.calls.length, 0, payload);
  }
});

test("ohne gueltige Betreiber-ID wird nie freigegeben", async () => {
  const f = fakeCall();
  const { out } = ctx();
  await makeHandler({ operatorId: "" }, f.call)(ctx({ senderId: "" , callback: { namespace: "gtr", payload: "a:" + N, chatId: "" } }).c);
  assert.equal(f.calls[0]?.req.is_group, true);
  assert.deepEqual(out.replies, []);
});

test("Details behalten die Knoepfe", async () => {
  const f = fakeCall({ ok: true, result: { text: "Details", keep_buttons: true } });
  const { c, out } = ctx({ callback: { namespace: "gtr", payload: "d:" + N, chatId: OP } });
  await makeHandler({ operatorId: OP }, f.call)(c);
  assert.equal(out.cleared, 0);
});

// ---- Befehle (ohne Sprachmodell) ----------------------------------------------------------------
import { makeCommands, formatLage } from "./index.mjs";
const cmdCtx = (over = {}) => ({ senderId: OP, from: "telegram:" + OP, channel: "telegram", ...over });
function recorder(results = {}) {
  const calls = [];
  return { calls, call: async (path, req) => { calls.push({ path, req }); return results[req.cmd] || { ok: true, result: { text: "ok", hinweis: "ok" } }; } };
}
const byName = (cmds) => Object.fromEntries(cmds.map((c) => [c.name, c]));

test("Befehle: Namen, nur Telegram, Auth, keine Kollision mit OpenClaw-Befehlen", () => {
  const cmds = makeCommands({ operatorId: OP });
  assert.deepEqual(cmds.map((c) => c.name).sort(), ["anhalten", "freigaben", "kontingent", "kosten", "lage"]);
  for (const c of cmds) { assert.deepEqual(c.channels, ["telegram"]); assert.equal(c.requireAuth, true); }
  for (const builtin of ["status", "stop", "approve", "help", "new", "reset", "codex"]) assert.ok(!cmds.some((c) => c.name === builtin));
});

for (const [name, over] of [["fremder Absender", { senderId: "111111", from: "telegram:111111" }], ["Gruppe", { from: "telegram:group:-100555" }],
  ["anderer Kanal", { channel: "discord" }], ["ohne Absender", { senderId: undefined }]]) {
  test("Befehle abgelehnt: " + name + " (kein Socket-Aufruf)", async () => {
    const r = recorder();
    for (const c of makeCommands({ operatorId: OP }, r.call)) {
      const res = await c.handler(cmdCtx(over));
      assert.match(res.text, /Nur fuer den Betreiber/);
    }
    assert.equal(r.calls.length, 0);
  });
}

test("/freigaben sendet nur 'resend' an beide Freigabe-Sockets, nie 'button'", async () => {
  const r = recorder();
  await byName(makeCommands({ operatorId: OP }, r.call)).freigaben.handler(cmdCtx());
  assert.deepEqual(r.calls.map((c) => c.path), ["/run/gtads-runner/approve.sock", "/run/gtads-planner/approve.sock"]);
  assert.ok(r.calls.every((c) => c.req.cmd === "resend" && c.req.sender_id === OP && c.req.is_group === false));
});

test("/anhalten stoppt Runner und Codex-Planung", async () => {
  const r = recorder();
  const res = await byName(makeCommands({ operatorId: OP }, r.call)).anhalten.handler(cmdCtx());
  assert.deepEqual(r.calls.map((c) => c.req.cmd), ["stop", "plan_cancel"]);
  assert.match(res.text, /Runner/);
});

test("/lage formatiert Fehler und laufende Arbeit; Dienst aus = klare Meldung", () => {
  const txt = formatLage({ ok: true, result: { proxy: "erreichbar", wartende_freigaben: 1, laufender_auftrag: { auftrag: 7, paket: "WP-009", seit_s: 125, tokens: 10, kosten_usd: 0.01, letzte_versuche: [{ n: 1, phase: "tests", ok: 0, summary: "1 failed" }] },
    letzte_fehler: [{ auftrag: 6, paket: "WP-009", zustand: "failed", zeit: 1794400000, grund: "container.env: permission denied" }], interne_fehler: [] } },
    { ok: false, error: "Freigabekomponente nicht erreichbar" });
  assert.match(txt, /Auftrag #7 WP-009 seit 2 min/);
  assert.match(txt, /permission denied/);
  assert.match(txt, /Codex-Planer: nicht erreichbar/);
});

test("Knopf 'Erneut vorbereiten' (p) wird an den Runner weitergereicht", async () => {
  const f = fakeCall();
  await makeHandler({ operatorId: OP }, f.call)(ctx({ callback: { namespace: "gtr", payload: "p:" + N, chatId: OP } }).c);
  assert.equal(f.calls[0].req.action, "p");
});
