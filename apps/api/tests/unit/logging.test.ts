import { describe, expect, it } from "vitest";
import {
  REDACTED,
  createRequestLogEntry,
  redactForLog,
  redactHeaders,
  redactUrl,
  serializeForLog,
} from "../../src/http/logging.js";

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

const CODE = "ABCD-EFGH-JKMN";

describe("U-10 Log-Redaktion", () => {
  it("redigiert die Geheimfelder im Body", () => {
    const serialized = serializeForLog({
      registration_code: CODE,
      signature: "SYN-signatur",
      public_key: "SYN-schluessel",
      password: "SYN-passwort",
      label: "SYN-Testhandy",
    });

    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain("SYN-signatur");
    expect(serialized).not.toContain("SYN-schluessel");
    expect(serialized).not.toContain("SYN-passwort");
    expect(serialized).toContain("SYN-Testhandy");
    expect(serialized).toContain(REDACTED);
  });

  it("redigiert Authorization und Cookie unabhaengig von der Schreibweise", () => {
    const headers = redactHeaders({
      Authorization: "Bearer SYN-access-token",
      Cookie: "gt_ads_session=SYN-session",
      "Set-Cookie": "gt_ads_session=SYN-session; HttpOnly",
      "Content-Type": "application/json",
    });

    expect(headers.authorization).toBe(REDACTED);
    expect(headers.cookie).toBe(REDACTED);
    expect(headers["set-cookie"]).toBe(REDACTED);
    expect(headers["content-type"]).toBe("application/json");

    const serialized = serializeForLog({ headers });
    expect(serialized).not.toContain("SYN-access-token");
    expect(serialized).not.toContain("SYN-session");
  });

  it("redigiert auch verschachtelte Objekte und Arrays", () => {
    const redacted = asRecord(
      redactForLog({
        request: {
          body: { registration_code: CODE },
          entries: [{ password: "SYN-passwort" }, { note: "ok" }],
        },
      }),
    );
    const request = asRecord(redacted.request);
    const body = asRecord(request.body);
    expect(body.registration_code).toBe(REDACTED);
    const entries = request.entries as Array<Record<string, unknown>>;
    expect(entries[0]?.password).toBe(REDACTED);
    expect(entries[1]?.note).toBe("ok");
  });

  it("laesst Fehlercodes stehen, redigiert aber Code-Werte", () => {
    const redacted = asRecord(
      redactForLog({ error: { code: "invalid_registration_code", message: "Der Code ist ungueltig." } }),
    );
    const error = asRecord(redacted.error);
    expect(error.code).toBe("invalid_registration_code");
    expect(error.message).toBe("Der Code ist ungueltig.");

    expect(asRecord(redactForLog({ code: CODE })).code).toBe(REDACTED);
  });

  it("bricht Zyklen und begrenzt die Tiefe ab", () => {
    const cyclic: Record<string, unknown> = { note: "ok" };
    cyclic.self = cyclic;
    const redacted = asRecord(redactForLog(cyclic));
    expect(redacted.self).toBe("[Circular]");

    const deep = asRecord(redactForLog({ a: { b: { c: 1 } } }, { maxDepth: 1 }));
    expect(deep.a).toBe("[MaxDepth]");
  });

  it("reduziert Fehlerobjekte auf Name und Meldung", () => {
    const redacted = asRecord(redactForLog(new Error("SYN-fehler")));
    expect(redacted.name).toBe("Error");
    expect(redacted.message).toBe("SYN-fehler");
    expect(redacted.stack).toBeUndefined();
  });

  it("entfernt Geheimnisse aus Query-Parametern", () => {
    const url = redactUrl("/v1/device/register?registration_code=" + CODE + "&label=SYN-Testhandy");
    expect(url).not.toContain(CODE);
    expect(url).toContain("label=SYN-Testhandy");
    expect(url).toContain(REDACTED);
    expect(redactUrl("/health")).toBe("/health");
  });

  it("baut einen sicheren Anfrage-Log-Eintrag", () => {
    const entry = createRequestLogEntry({
      method: "POST",
      url: "/v1/device/register?registration_code=" + CODE,
      headers: { Authorization: "Bearer SYN-token" },
      body: { registration_code: CODE, public_key: "SYN-key" },
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(CODE);
    expect(serialized).not.toContain("SYN-token");
    expect(serialized).not.toContain("SYN-key");
    expect(serialized).toContain("POST");
  });

  it("serialisiert undefined als null", () => {
    expect(serializeForLog(undefined)).toBe("null");
  });
});
