// GT-Ads Freigabe-Plugin (Betreiber 2026-11-11): verarbeitet NUR Telegram-Schaltflaechen der Namensraeume "gtr" (Coding-Runner)
// und "gtp" (Codex-Planer). Kein Sprachmodell, keine Werkzeuge, keine Textbefehle: Textnachrichten koennen hier nie etwas freigeben.
// Pruefung hier (1. Stufe): Absender-ID aus dem Telegram-Callback (callback.from.id) == Betreiber, privater Chat (chatId == Absender, keine Gruppe).
// Die verbindliche Pruefung (Nonce einmalig/befristet, Bindung an Paket+Hash, Absender, Chat, Protokoll) macht die Freigabekomponente
// hinter dem jeweiligen Freigabe-Socket erneut (2. Stufe). Antworttexte stammen ausschliesslich von dort.
import net from "node:net";

const NS = { gtr: "runnerApproveSocket", gtp: "plannerApproveSocket" };
const DEFAULT_SOCK = { gtr: "/run/gtads-runner/approve.sock", gtp: "/run/gtads-planner/approve.sock" };
const PAYLOAD = /^([ardp]):([A-Za-z0-9_-]{22})$/;
const CONTROL = { runner: "/run/gtads-runner/control.sock", planner: "/run/gtads-planner/control.sock" };

export function callSocket(path, request, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    const sock = net.createConnection(path);
    sock.setTimeout(timeoutMs, () => finish({ ok: false, error: "Freigabekomponente antwortet nicht" }));
    sock.on("connect", () => sock.write(JSON.stringify(request) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > 65536) return finish({ ok: false, error: "Antwort zu gross" });
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish({ ok: false, error: "Antwort nicht lesbar" }); }
      }
    });
    sock.on("error", () => finish({ ok: false, error: "Freigabekomponente nicht erreichbar" }));
  });
}

export function makeHandler(cfg, call = callSocket) {
  const operator = String(cfg.operatorId || "");
  return async (ctx) => {
    const ns = ctx.callback?.namespace;
    const m = PAYLOAD.exec(ctx.callback?.payload || "");
    const sender = String(ctx.senderId || "");
    const chat = String(ctx.callback?.chatId || "");
    if (!m || !NS[ns]) {
      await ctx.respond.reply({ text: "Ungueltige Schaltflaeche." });
      return { handled: true };
    }
    // 1. Stufe: nur der Betreiber, nur im privaten Chat (Gruppen/Kanaele/Foren nie)
    const [, action, nonce] = m;
    const path = (cfg[NS[ns]] || DEFAULT_SOCK[ns]);
    if (!/^[0-9]{5,15}$/.test(operator) || sender !== operator || ctx.isGroup || ctx.isForum || chat !== sender || ctx.threadId != null) {
      // Fremder Absender / kein privater Chat: nichts anzeigen. Weitergabe nur, damit die Freigabekomponente den Versuch protokolliert
      // (sie lehnt ihn selbst ab, bevor irgendetwas verbraucht wird).
      await call(path, { cmd: "button", nonce, action, sender_id: sender, chat_id: chat, is_group: true });
      return { handled: true };
    }
    const res = await call(path, { cmd: "button", nonce, action, sender_id: sender, chat_id: chat, is_group: Boolean(ctx.isGroup) });
    const text = String((res.ok ? res.result?.text : "Fehler: " + res.error) || "keine Antwort").slice(0, 3500);
    if (action === "d" || res.result?.keep_buttons) {
      await ctx.respond.reply({ text });
    } else {
      await ctx.respond.clearButtons().catch(() => {});
      await ctx.respond.reply({ text });
    }
    return { handled: true };
  };
}

// ---- Feste Befehle (ohne Sprachmodell): /lage /freigaben /anhalten /kontingent /kosten -------------------------------------
// Nur der Betreiber im privaten Chat (from == "telegram:<Betreiber-ID>"). Befehle zeigen an oder halten an; sie geben NIE etwas frei.
// /freigaben laesst die Dienste offene Freigaben mit frischen Knoepfen erneut an den privaten Chat des Betreibers senden.
const zeit = (ts) => (ts ? new Date(ts * 1000).toLocaleString("de-AT", { timeZone: "Europe/Vienna", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
const dauer = (s) => (s == null ? "-" : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const fehlerText = (r) => (r.ok ? null : `nicht erreichbar/Fehler: ${r.error}`);

export function formatLage(runner, planner) {
  const out = ["LAGE"];
  if (!runner.ok) out.push(`Runner: ${fehlerText(runner)}`);
  else {
    const h = runner.result;
    out.push(`Runner: laeuft · Proxy ${h.proxy} · wartende Freigaben: ${h.wartende_freigaben}`);
    const a = h.laufender_auftrag;
    if (a) {
      out.push(`  Auftrag #${a.auftrag} ${a.paket}${a.einheit ? " " + a.einheit : ""} seit ${dauer(a.seit_s)} · ${a.tokens} Tokens · ${a.kosten_usd} USD`);
      for (const v of a.letzte_versuche || []) out.push(`    Versuch ${v.n} ${v.phase}: ${v.ok ? "ok" : "Fehler"}${v.summary ? " – " + String(v.summary).slice(0, 160) : ""}`);
    } else out.push("  kein laufender Auftrag");
    for (const f of (h.letzte_fehler || []).slice(0, 3)) out.push(`  ✗ #${f.auftrag} ${f.paket}${f.einheit ? " " + f.einheit : ""} ${f.zustand} (${zeit(f.zeit)}): ${String(f.grund || "").slice(0, 220)}`);
    for (const f of (h.interne_fehler || []).slice(0, 2)) out.push(`  ! intern (${zeit(f.zeit)}): ${f.detail}`);
  }
  if (!planner.ok) out.push(`Codex-Planer: ${fehlerText(planner)}`);
  else {
    const p = planner.result;
    const l = p.laufende_planung;
    out.push(`Codex-Planer: laeuft · wartende Entwuerfe: ${p.wartende_entwuerfe}${l ? ` · Planung #${l.anfrage} (${l.pakete} Pakete) seit ${dauer(l.seit_s)}` : " · keine laufende Planung"}`);
    for (const f of (p.letzte_fehler || []).slice(0, 2)) out.push(`  ✗ Planung #${f.anfrage} ${f.zustand} (${zeit(f.zeit)}): ${String(f.grund || "").slice(0, 220)}`);
  }
  return out.join("\n").slice(0, 3800);
}

export function formatKosten(r) {
  if (!r.ok) return `Kosten: ${fehlerText(r)}`;
  const k = r.result;
  const out = [`KOSTEN DeepSeek: gesamt ${k.gesamt_usd} USD · letzte 24 h ${k.letzte_24h_usd} USD (${k.letzte_24h_tokens} Tokens)`,
    `Pilotbudget ${k.pilotbudget_usd} USD · Rest ${k.rest_pilotbudget_usd} USD`];
  for (const p of (k.je_paket || []).slice(0, 8)) out.push(`  ${p.paket}: ${p.auftraege} Auftraege · ${p.tokens} Tokens · ${p.usd} USD`);
  out.push(k.hinweis);
  return out.join("\n");
}

export function formatCodex(limits, health) {
  const out = ["CODEX"];
  if (!limits.ok) out.push(`Kontingent: ${fehlerText(limits)}`);
  else {
    const q = limits.result;
    if (q.five_hour == null) out.push(`Kontingent: ${q.pending ? "wird gerade gemessen – in einer Minute erneut /kontingent" : "nicht messbar – " + q.reason}`);
    else out.push(`Kontingent: 5 h ${q.five_hour.used_percent} % (Reset ${zeit(q.five_hour.reset_at / 1000)}) · Woche ${q.week.used_percent} % (Reset ${zeit(q.week.reset_at / 1000)})`,
      `Grenze ${q.limit_percent} % + Reserve ${q.reserve_percent} % → ${q.allowed ? "Codex darf starten" : "GESPERRT: " + q.reason}`);
  }
  if (health.ok) {
    const l = health.result.laufende_planung;
    out.push(l ? `Planung #${l.anfrage} laeuft seit ${dauer(l.seit_s)} (/anhalten bricht ab)` : "keine laufende Planung", `wartende Entwuerfe: ${health.result.wartende_entwuerfe} (/freigaben zeigt sie mit Knoepfen)`);
  } else out.push(`Planer: ${fehlerText(health)}`);
  return out.join("\n");
}

export function makeCommands(cfg, call = callSocket) {
  const operator = String(cfg.operatorId || "");
  const sock = (k) => cfg[k + "ControlSocket"] || CONTROL[k];
  const approveSock = (ns) => cfg[NS[ns]] || DEFAULT_SOCK[ns];
  const guard = (ctx) => /^[0-9]{5,15}$/.test(operator) && String(ctx.senderId || "") === operator && ctx.from === "telegram:" + operator && ctx.channel === "telegram";
  const wrap = (fn) => async (ctx) => (guard(ctx) ? { text: await fn(ctx) } : { text: "Nur fuer den Betreiber im privaten Chat." });
  return [
    { name: "lage", description: "Lage: Dienste, laufende Arbeit, letzte Fehler (ohne KI)",
      handler: wrap(async () => formatLage(await call(sock("runner"), { cmd: "health" }), await call(sock("planner"), { cmd: "plan_health" }))) },
    { name: "freigaben", description: "Offene Freigaben erneut mit Knoepfen senden (ohne KI)",
      handler: wrap(async (ctx) => {
        const req = { cmd: "resend", sender_id: String(ctx.senderId), chat_id: String(ctx.senderId), is_group: false };
        const parts = [];
        for (const ns of ["gtr", "gtp"]) {
          const r = await call(approveSock(ns), req);
          parts.push(r.ok ? r.result.text : `${ns === "gtr" ? "Runner" : "Planer"}: ${r.error}`);
        }
        return parts.join("\n");
      }) },
    { name: "anhalten", description: "Laufenden Auftrag und Codex-Planung anhalten (ohne KI)",
      handler: wrap(async () => {
        const r = await call(sock("runner"), { cmd: "stop" });
        const p = await call(sock("planner"), { cmd: "plan_cancel" });
        return [`Runner: ${r.ok ? "Stopp angefordert" : r.error}`, `Codex-Planung: ${p.ok ? p.result.hinweis : p.error}`].join("\n");
      }) },
    { name: "kontingent", description: "Codex-Kontingent und Planungsstand (ohne KI)",
      handler: wrap(async () => formatCodex(await call(sock("planner"), { cmd: "plan_limits" }), await call(sock("planner"), { cmd: "plan_health" }))) },
    { name: "kosten", description: "DeepSeek-Kosten und Pilotbudget (ohne KI)",
      handler: wrap(async () => formatKosten(await call(sock("runner"), { cmd: "costs" }))) },
  ].map((c) => ({ ...c, channels: ["telegram"], requireAuth: true, acceptsArgs: false }));
}

export default {
  id: "gtads-freigabe",
  name: "GT-Ads Freigabe",
  description: "Deterministische Telegram-Freigaben (Schaltflaechen); ohne Sprachmodell.",
  register(api) {
    const cfg = api.pluginConfig || {};
    const handler = makeHandler(cfg);
    if (!/^[0-9]{5,15}$/.test(String(cfg.operatorId || ""))) api.logger?.error?.("gtads-freigabe: operatorId fehlt/ungueltig; alle Freigaben werden abgelehnt");
    for (const namespace of Object.keys(NS)) {
      const r = api.registerInteractiveHandler({ channel: "telegram", namespace, handler });
      if (r && r.ok === false) api.logger?.error?.("gtads-freigabe: Namensraum " + namespace + " nicht registriert: " + r.error);
      else api.logger?.info?.("gtads-freigabe: Telegram-Namensraum " + namespace + " registriert");
    }
    for (const cmd of makeCommands(cfg)) {
      try {
        api.registerCommand(cmd);
        api.logger?.info?.("gtads-freigabe: Befehl /" + cmd.name + " registriert");
      } catch (e) {
        api.logger?.error?.("gtads-freigabe: Befehl /" + cmd.name + " nicht registriert: " + (e?.message || e));
      }
    }
  },
};
