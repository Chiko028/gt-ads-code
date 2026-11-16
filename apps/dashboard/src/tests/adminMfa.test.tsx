import { act } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminShell, useAdminSession } from "../admin/AdminShell";
import type { FetchLike } from "../admin/adminApi";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

function createFetchDouble() {
  const calls: FetchCall[] = [];
  let handler: FetchHandler = () => {
    throw new Error("Kein Testadapter gesetzt");
  };

  const fetchImpl: FetchLike = (input, init) => {
    const call: FetchCall = {
      url: input,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? null : String(init.body),
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  };

  return {
    fetchImpl,
    calls,
    setHandler(next: FetchHandler) {
      handler = next;
    },
    posts(suffix: string) {
      return calls.filter(
        (call) => call.method === "POST" && call.url.endsWith(suffix),
      );
    },
    gets(suffix: string) {
      return calls.filter(
        (call) => call.method === "GET" && call.url.endsWith(suffix),
      );
    },
    logouts() {
      return calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/admin/logout"),
      );
    },
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function apiErrorBody() {
  return {
    error: {
      code: "unauthorized",
      message: "SYN-Servermeldung mit internem Detail",
      request_id: "SYN-req-cx067",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function ProtectedContent() {
  const { sessionStatus, role } = useAdminSession();
  return (
    <p>
      Geschützter Inhalt ({sessionStatus}, {role})
    </p>
  );
}

function renderShell(
  net: ReturnType<typeof createFetchDouble>,
  props: { mfaRequired?: boolean; role?: "Admin" | "Operator" } = {},
) {
  return render(
    <AdminShell fetchImpl={net.fetchImpl} {...props}>
      <ProtectedContent />
    </AdminShell>,
  );
}

async function loginToMfa(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.type(screen.getByLabelText("Passwort"), "geheim");
  await user.click(screen.getByRole("button", { name: "Anmelden" }));
  await screen.findByRole("heading", { name: "Zwei-Faktor-Anmeldung" });
}

describe("CX-067 Wiederherstellungsanmeldung und Codesatz-Ausgabe", () => {
  it("wechselt im TOTP-Schritt zur Wiederherstellung und sendet den Code nur an den Recovery-Endpunkt", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    let sessionReady = false;

    net.setHandler((call) => {
      if (call.method === "GET" && call.url.endsWith("/admin/registration-codes")) {
        return sessionReady
          ? jsonResponse(200, { items: [] })
          : jsonResponse(401, apiErrorBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        return jsonResponse(200, { mfa_required: true, role: "Admin" });
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/recovery/verify")
      ) {
        sessionReady = true;
        return emptyResponse(204);
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/totp/verify")
      ) {
        throw new Error("TOTP darf im Wiederherstellungszweig nicht aufgerufen werden");
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    renderShell(net);
    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    await loginToMfa(user);

    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    expect(screen.getByLabelText("TOTP-Code")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Wiederherstellungscode verwenden" }),
    );
    expect(screen.getByLabelText("Wiederherstellungscode")).toBeTruthy();
    expect(screen.queryByLabelText("TOTP-Code")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Zurück zur TOTP-Eingabe" }),
    );
    expect(screen.getByLabelText("TOTP-Code")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Wiederherstellungscode verwenden" }),
    );
    await user.type(
      screen.getByLabelText("Wiederherstellungscode"),
      "RECOVERY-CODE-1",
    );
    await user.click(
      screen.getByRole("button", { name: "Mit Wiederherstellungscode anmelden" }),
    );

    expect(
      await screen.findByText("Geschützter Inhalt (authenticated, Admin)"),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Registrierungscodes" }),
    ).toBeTruthy();

    const loginCalls = net.posts("/admin/login");
    expect(loginCalls).toHaveLength(1);
    const recoveryCalls = net.posts("/admin/auth/recovery/verify");
    expect(recoveryCalls).toHaveLength(1);
    expect(JSON.parse(String(recoveryCalls[0]?.body))).toEqual({
      code: "RECOVERY-CODE-1",
    });
    expect(net.posts("/admin/auth/totp/verify")).toHaveLength(0);
    expect(net.calls.filter((call) => call.url.includes("recovery-codes"))).toHaveLength(0);
  });

  it("zeigt ungültige Codes, abgelaufene Challenge, Rate-Limit, 403 und Validierungsfehler ohne Anmeldung und ohne automatische Wiederholung", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    let recoveryAttempt = 0;

    net.setHandler((call) => {
      if (call.method === "GET" && call.url.endsWith("/admin/registration-codes")) {
        return jsonResponse(401, apiErrorBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        return jsonResponse(200, { mfa_required: true, role: "Admin" });
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/recovery/verify")
      ) {
        recoveryAttempt += 1;
        if (recoveryAttempt === 1 || recoveryAttempt === 2) {
          return jsonResponse(401, apiErrorBody());
        }
        if (recoveryAttempt === 3) {
          return jsonResponse(429, apiErrorBody(), { "Retry-After": "60" });
        }
        if (recoveryAttempt === 4) {
          return jsonResponse(403, apiErrorBody());
        }
        return jsonResponse(400, apiErrorBody());
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    renderShell(net);
    await screen.findByRole("heading", { name: "Anmeldung" });

    async function attemptRecovery(code: string): Promise<void> {
      await loginToMfa(user);
      await user.click(
        screen.getByRole("button", { name: "Wiederherstellungscode verwenden" }),
      );
      await user.type(screen.getByLabelText("Wiederherstellungscode"), code);
      await user.click(
        screen.getByRole("button", {
          name: "Mit Wiederherstellungscode anmelden",
        }),
      );
    }

    await attemptRecovery("FALSCH-1");
    expect(
      await screen.findByText(
        "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(net.posts("/admin/auth/recovery/verify")).toHaveLength(1);

    await attemptRecovery("ABGELAUFEN-2");
    expect(
      await screen.findByText(
        "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
      ),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(net.posts("/admin/auth/recovery/verify")).toHaveLength(2);

    await attemptRecovery("RATE-LIMIT-3");
    expect(
      await screen.findByText(
        "Zu viele Versuche. Bitte in 60 Sekunden erneut versuchen.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Zwei-Faktor-Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(net.posts("/admin/auth/recovery/verify")).toHaveLength(3);

    await user.click(
      screen.getByRole("button", {
        name: "Mit Wiederherstellungscode anmelden",
      }),
    );
    expect(
      await screen.findByText("Die Aktion ist nicht erlaubt."),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Zwei-Faktor-Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();

    await user.click(
      screen.getByRole("button", {
        name: "Mit Wiederherstellungscode anmelden",
      }),
    );
    expect(
      await screen.findByText("Die Anfrage ist ungültig."),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Zwei-Faktor-Anmeldung" }),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(net.posts("/admin/auth/recovery/verify")).toHaveLength(5);
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
  });

  it("erzeugt nach Warnung und frischer TOTP-Eingabe genau einen Codesatz, zeigt Klartext nur nach Erfolg und entfernt ihn beim Schließen und Abmelden", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    let mfaVerified = false;
    let generateCalls = 0;
    const pendingGenerate = deferred<Response>();
    const hrefBefore = window.location.href;

    net.setHandler((call) => {
      if (call.method === "GET" && call.url.endsWith("/admin/registration-codes")) {
        return mfaVerified
          ? jsonResponse(200, { items: [] })
          : jsonResponse(401, apiErrorBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        return jsonResponse(200, { mfa_required: true, role: "Admin" });
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/totp/verify")
      ) {
        mfaVerified = true;
        return emptyResponse(204);
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/recovery-codes")
      ) {
        generateCalls += 1;
        if (generateCalls === 1) {
          return pendingGenerate.promise;
        }
        return jsonResponse(200, {
          codes: ["GAMMA-3333"],
          created_at: "2026-11-16T03:30:00.000Z",
        });
      }
      if (call.method === "POST" && call.url.endsWith("/admin/logout")) {
        return emptyResponse(204);
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    renderShell(net);
    await screen.findByRole("heading", { name: "Anmeldung" });
    await loginToMfa(user);
    await user.type(screen.getByLabelText("TOTP-Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(
      await screen.findByText("Geschützter Inhalt (authenticated, Admin)"),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Wiederherstellungscodes erzeugen" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Wiederherstellungscodes",
    });
    expect(
      within(dialog).getByText(
        /Ein neuer Codesatz macht alle früheren Wiederherstellungscodes sofort ungültig/i,
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText("ALPHA-1111")).toBeNull();
    expect(within(dialog).queryByText("BETA-2222")).toBeNull();

    await user.type(
      within(dialog).getByLabelText("TOTP-Code (6 Ziffern)"),
      "654321",
    );
    await user.click(
      within(dialog).getByLabelText(
        /Ich bestätige, dass ein neuer Codesatz alle früheren Codes ungültig macht/i,
      ),
    );

    const generateButton = within(dialog).getByRole("button", {
      name: "Codesatz erzeugen",
    });
    fireEvent.click(generateButton);
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(net.posts("/admin/auth/recovery-codes")).toHaveLength(1);
    });
    expect(net.posts("/admin/auth/recovery-codes")[0]?.body).toBe(
      JSON.stringify({ totp_code: "654321" }),
    );
    expect(screen.queryByText("ALPHA-1111")).toBeNull();

    await act(async () => {
      pendingGenerate.resolve(
        jsonResponse(200, {
          codes: ["ALPHA-1111", "BETA-2222"],
          created_at: "2026-11-16T03:20:00.000Z",
        }),
      );
    });

    expect(await screen.findByText("ALPHA-1111")).toBeTruthy();
    expect(screen.getByText("BETA-2222")).toBeTruthy();
    expect(
      screen.getByText(/Bewahren Sie diese Codes außerhalb der Anwendung sicher auf/i),
    ).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).toBe(hrefBefore);
    expect(document.querySelector('a[href*="ALPHA-1111"]')).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("ALPHA-1111")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Wiederherstellungscodes" }),
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Wiederherstellungscodes erzeugen" }),
    );
    const secondDialog = screen.getByRole("dialog", {
      name: "Wiederherstellungscodes",
    });
    await user.type(
      within(secondDialog).getByLabelText("TOTP-Code (6 Ziffern)"),
      "112233",
    );
    await user.click(
      within(secondDialog).getByLabelText(
        /Ich bestätige, dass ein neuer Codesatz alle früheren Codes ungültig macht/i,
      ),
    );
    await user.click(
      within(secondDialog).getByRole("button", { name: "Codesatz erzeugen" }),
    );
    expect(await screen.findByText("GAMMA-3333")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("GAMMA-3333")).toBeNull();
    });
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(net.logouts()).toHaveLength(1);
  });

  it("zeigt Operatoren keine Codesatzverwaltung und generiert bei unklarem Ausgang nicht automatisch neu", async () => {
    const operatorNet = createFetchDouble();
    const operatorUser = userEvent.setup();
    let operatorLoggedIn = false;
    operatorNet.setHandler((call) => {
      if (call.method === "GET" && call.url.endsWith("/admin/registration-codes")) {
        return operatorLoggedIn
          ? jsonResponse(403, apiErrorBody())
          : jsonResponse(401, apiErrorBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        operatorLoggedIn = true;
        return emptyResponse(204);
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    renderShell(operatorNet);
    await screen.findByRole("heading", { name: "Anmeldung" });
    await operatorUser.type(screen.getByLabelText("Passwort"), "geheim");
    await operatorUser.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(
      await screen.findByText("Geschützter Inhalt (authenticated, Operator)"),
    ).toBeTruthy();
    expect(await screen.findByText("Die Aktion ist nicht erlaubt.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Wiederherstellungscodes erzeugen" }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: "Sicherheit" })).toBeNull();
    cleanup();

    const net = createFetchDouble();
    const user = userEvent.setup();
    let mfaVerified = false;

    net.setHandler((call) => {
      if (call.method === "GET" && call.url.endsWith("/admin/registration-codes")) {
        return mfaVerified
          ? jsonResponse(200, { items: [] })
          : jsonResponse(401, apiErrorBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        return jsonResponse(200, { mfa_required: true, role: "Admin" });
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/totp/verify")
      ) {
        mfaVerified = true;
        return emptyResponse(204);
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/auth/recovery-codes")
      ) {
        throw new TypeError("Verbindung unterbrochen");
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    renderShell(net);
    await screen.findByRole("heading", { name: "Anmeldung" });
    await loginToMfa(user);
    await user.type(screen.getByLabelText("TOTP-Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(
      await screen.findByText("Geschützter Inhalt (authenticated, Admin)"),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Wiederherstellungscodes erzeugen" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Wiederherstellungscodes",
    });
    await user.type(
      within(dialog).getByLabelText("TOTP-Code (6 Ziffern)"),
      "445566",
    );
    await user.click(
      within(dialog).getByLabelText(
        /Ich bestätige, dass ein neuer Codesatz alle früheren Codes ungültig macht/i,
      ),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Codesatz erzeugen" }),
    );

    expect(
      await screen.findByText(/Der Ausgang der Erzeugung ist unklar/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/können nicht erneut abgerufen werden/i),
    ).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Neue Wiederherstellungscodes" })).toBeNull();
    expect(
      (within(dialog).getByLabelText("TOTP-Code (6 Ziffern)") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (within(dialog).getByLabelText(
        /Ich bestätige, dass ein neuer Codesatz alle früheren Codes ungültig macht/i,
      ) as HTMLInputElement).checked,
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(net.posts("/admin/auth/recovery-codes")).toHaveLength(1);
    expect(
      within(dialog).getByRole("button", { name: "Codesatz erzeugen" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeTruthy();
  });
});
