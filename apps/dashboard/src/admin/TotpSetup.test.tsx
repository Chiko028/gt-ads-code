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

import { App } from "../App";
import { AdminShell, TotpSetupScreen } from "./AdminShell";
import type { FetchLike } from "./adminApi";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENROLLMENT_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "JBSWY3DPEHPK3PXP";
const SECOND_SECRET = "KRSXG5CTMVRXEZLU";
const FUTURE = "2999-01-01T00:00:00.000Z";
const CREATED_AT = "2026-11-16T04:00:00.000Z";

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
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function unauthorizedBody() {
  return { error: { code: "unauthorized", message: "SYN-Meldung" } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function renderSetup(net: ReturnType<typeof createFetchDouble>) {
  return render(
    <AdminShell fetchImpl={net.fetchImpl}>
      <TotpSetupScreen />
    </AdminShell>,
  );
}

async function loginAdmin(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("heading", { name: "Anmeldung" });
  await user.type(screen.getByLabelText("Passwort"), "geheim");
  await user.click(screen.getByRole("button", { name: "Anmelden" }));
  await screen.findByRole("button", { name: "TOTP einrichten" });
}

async function startSetup(
  user: ReturnType<typeof userEvent.setup>,
  secret: string,
) {
  await user.click(screen.getByRole("button", { name: "TOTP einrichten" }));
  await user.type(screen.getByLabelText("Passwort"), "geheim-neu");
  await user.click(screen.getByRole("button", { name: "Weiter" }));
  expect(await screen.findByText(secret)).toBeTruthy();
}

function adminSessionHandler(
  net: ReturnType<typeof createFetchDouble>,
  options: {
    readonly setup?: () => Response | Promise<Response>;
    readonly confirm?: () => Response | Promise<Response>;
  } = {},
) {
  let loggedIn = false;
  net.setHandler((call) => {
    if (call.method === "GET" && call.url.endsWith("/admin/registration-codes")) {
      return loggedIn
        ? jsonResponse(200, { items: [] })
        : jsonResponse(401, unauthorizedBody());
    }
    if (call.method === "POST" && call.url.endsWith("/admin/login")) {
      loggedIn = true;
      return jsonResponse(200, { role: "Admin" });
    }
    if (
      call.method === "POST" &&
      call.url.endsWith("/admin/mfa/totp/setup/confirm")
    ) {
      return options.confirm === undefined
        ? jsonResponse(401, unauthorizedBody())
        : options.confirm();
    }
    if (call.method === "POST" && call.url.endsWith("/admin/mfa/totp/setup")) {
      return options.setup === undefined
        ? jsonResponse(201, {
            enrollment_id: ENROLLMENT_ID,
            expires_at: FUTURE,
            secret: SECRET,
            otpauth_uri: "otpauth://totp/GT-Ads:admin?secret=" + SECRET,
          })
        : options.setup();
    }
    if (call.method === "DELETE" && call.url.includes("/admin/mfa/totp/setup/")) {
      return emptyResponse(204);
    }
    if (call.method === "POST" && call.url.endsWith("/admin/logout")) {
      return emptyResponse(204);
    }
    throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
  });
}

describe("CX-110 TOTP-Einrichtung", () => {
  it("beginnt mit erneuter Passworteingabe, zeigt das Base32-Geheimnis und aktiviert MFA erst nach der Bestätigungsantwort", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    const pendingConfirm = deferred<Response>();
    const hrefBefore = window.location.href;
    adminSessionHandler(net, { confirm: () => pendingConfirm.promise });

    renderSetup(net);
    await loginAdmin(user);
    expect(screen.queryByLabelText("Passwort")).toBeNull();

    await user.click(screen.getByRole("button", { name: "TOTP einrichten" }));
    expect(
      screen.getByText(/Bitte das Passwort erneut eingeben/i),
    ).toBeTruthy();
    await user.type(screen.getByLabelText("Passwort"), "geheim-neu");
    await user.click(screen.getByRole("button", { name: "Weiter" }));

    expect(await screen.findByText(SECRET)).toBeTruthy();
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    const region = screen.getByRole("region", {
      name: "Zwei-Faktor-Einrichtung",
    });
    expect(within(region).getByText("GT-Ads")).toBeTruthy();
    expect(within(region).getByText("6")).toBeTruthy();
    expect(within(region).getByText("30 Sekunden")).toBeTruthy();

    const startCalls = net.posts("/admin/mfa/totp/setup");
    expect(startCalls).toHaveLength(1);
    expect(JSON.parse(String(startCalls[0]?.body))).toEqual({
      password: "geheim-neu",
    });

    await user.type(screen.getByLabelText("Erster Code (6 Ziffern)"), "123456");
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => {
      expect(net.posts("/admin/mfa/totp/setup/confirm")).toHaveLength(1);
    });
    expect(
      JSON.parse(String(net.posts("/admin/mfa/totp/setup/confirm")[0]?.body)),
    ).toEqual({ enrollment_id: ENROLLMENT_ID, code: "123456" });
    expect(screen.queryByText("MFA ist aktiv.")).toBeNull();
    expect(screen.getByText(SECRET)).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);

    await act(async () => {
      pendingConfirm.resolve(
        jsonResponse(201, {
          codes: ["ALPHA-1111", "BETA-2222"],
          activated_at: CREATED_AT,
        }),
      );
    });

    expect(await screen.findByText("MFA ist aktiv.")).toBeTruthy();
    expect(screen.getByText("ALPHA-1111")).toBeTruthy();
    expect(screen.getByText("BETA-2222")).toBeTruthy();
    expect(
      screen.getByText(/Bewahren Sie diese Codes außerhalb der Anwendung/i),
    ).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByLabelText("Erster Code (6 Ziffern)")).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).toBe(hrefBefore);
  });

  it("zeigt falschen Code, abgelaufene Einrichtung und unklaren Ausgang getrennt und sendet bei Doppelklick nur einen Request", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    adminSessionHandler(net);

    renderSetup(net);
    await loginAdmin(user);
    await startSetup(user, SECRET);
    await user.type(screen.getByLabelText("Erster Code (6 Ziffern)"), "999999");
    const confirmButton = screen.getByRole("button", { name: "Bestätigen" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(await screen.findByText(/Der Code ist falsch/)).toBeTruthy();
    await waitFor(() => {
      expect(net.posts("/admin/mfa/totp/setup/confirm")).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(net.posts("/admin/mfa/totp/setup/confirm")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Anmeldung" })).toBeNull();
    expect(screen.getByText(SECRET)).toBeTruthy();
    cleanup();

    const expiredNet = createFetchDouble();
    const expiredUser = userEvent.setup();
    adminSessionHandler(expiredNet, {
      setup: () =>
        jsonResponse(201, {
          enrollment_id: ENROLLMENT_ID,
          expires_at: "2000-01-01T00:00:00.000Z",
          secret: SECRET,
        }),
    });
    renderSetup(expiredNet);
    await loginAdmin(expiredUser);
    await startSetup(expiredUser, SECRET);
    await expiredUser.type(
      screen.getByLabelText("Erster Code (6 Ziffern)"),
      "123456",
    );
    await expiredUser.click(screen.getByRole("button", { name: "Bestätigen" }));

    expect(
      await screen.findByText(/Die Einrichtung ist abgelaufen/),
    ).toBeTruthy();
    expect(expiredNet.posts("/admin/mfa/totp/setup/confirm")).toHaveLength(0);
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByLabelText("Passwort")).toBeTruthy();
    cleanup();

    const unclearNet = createFetchDouble();
    const unclearUser = userEvent.setup();
    adminSessionHandler(unclearNet, {
      confirm: () => {
        throw new TypeError("Verbindung unterbrochen");
      },
    });
    renderSetup(unclearNet);
    await loginAdmin(unclearUser);
    await startSetup(unclearUser, SECRET);
    await unclearUser.type(
      screen.getByLabelText("Erster Code (6 Ziffern)"),
      "123456",
    );
    await unclearUser.click(screen.getByRole("button", { name: "Bestätigen" }));

    expect(
      await screen.findByText(/Der Ausgang der Bestätigung ist unklar/),
    ).toBeTruthy();
    expect(screen.getByText(/Sicherheitsverwaltung/)).toBeTruthy();
    expect(screen.queryByText("MFA ist aktiv.")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(unclearNet.posts("/admin/mfa/totp/setup/confirm")).toHaveLength(1);
    expect(unclearNet.posts("/admin/mfa/totp/setup")).toHaveLength(1);
    expect(screen.getByText(SECRET)).toBeTruthy();
  });

  it("verwirft die Einrichtung beim Abbrechen und entfernt Passwort, Geheimnis und Codes bei Sitzungsende, ohne späte Antworten zu übernehmen", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    const pendingConfirm = deferred<Response>();
    let starts = 0;
    adminSessionHandler(net, {
      setup: () => {
        starts += 1;
        return jsonResponse(201, {
          enrollment_id: ENROLLMENT_ID,
          expires_at: FUTURE,
          secret: starts === 1 ? SECRET : SECOND_SECRET,
        });
      },
      confirm: () => pendingConfirm.promise,
    });

    renderSetup(net);
    await loginAdmin(user);
    await startSetup(user, SECRET);
    await user.click(screen.getByRole("button", { name: "Einrichtung abbrechen" }));

    expect(
      await screen.findByText("Die Einrichtung wurde abgebrochen."),
    ).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
    const deletes = net.calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain(ENROLLMENT_ID);

    await startSetup(user, SECOND_SECRET);
    await user.type(screen.getByLabelText("Erster Code (6 Ziffern)"), "123456");
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => {
      expect(net.posts("/admin/mfa/totp/setup/confirm")).toHaveLength(1);
    });
    await user.click(screen.getByRole("button", { name: "Abmelden" }));

    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByText(SECOND_SECRET)).toBeNull();
    expect(screen.queryByLabelText("Erster Code (6 Ziffern)")).toBeNull();

    await act(async () => {
      pendingConfirm.resolve(
        jsonResponse(201, { codes: ["LATE-9999"], activated_at: CREATED_AT }),
      );
    });
    expect(screen.queryByText("LATE-9999")).toBeNull();
    expect(screen.queryByText("MFA ist aktiv.")).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("zeigt die Einrichtung in der tatsächlichen App nur Admins und übergibt die einmaligen Codes an die vorhandene Darstellung", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    let loggedIn = false;
    net.setHandler((call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith("/admin/registration-codes")
      ) {
        return loggedIn
          ? jsonResponse(200, { items: [] })
          : jsonResponse(401, unauthorizedBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        loggedIn = true;
        return jsonResponse(200, { role: "Admin" });
      }
      if (call.method === "GET" && call.url.endsWith("/admin/devices")) {
        return jsonResponse(200, {
          server_time: "2026-11-16T04:00:00.000Z",
          online_threshold_s: 60,
          items: [],
          truncated: false,
        });
      }
      if (
        call.method === "POST" &&
        call.url.endsWith("/admin/mfa/totp/setup/confirm")
      ) {
        return jsonResponse(201, {
          codes: ["OMEGA-7777"],
          activated_at: CREATED_AT,
        });
      }
      if (call.method === "POST" && call.url.endsWith("/admin/mfa/totp/setup")) {
        return jsonResponse(201, {
          enrollment_id: ENROLLMENT_ID,
          expires_at: FUTURE,
          secret: SECRET,
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    render(<App fetchImpl={net.fetchImpl} />);
    await loginAdmin(user);
    await startSetup(user, SECRET);
    await user.type(screen.getByLabelText("Erster Code (6 Ziffern)"), "123456");
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));

    expect(await screen.findByText("MFA ist aktiv.")).toBeTruthy();
    expect(screen.getByText("OMEGA-7777")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "Neue Wiederherstellungscodes" }),
    ).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    cleanup();

    const operatorNet = createFetchDouble();
    const operatorUser = userEvent.setup();
    let operatorLoggedIn = false;
    operatorNet.setHandler((call) => {
      if (
        call.method === "GET" &&
        call.url.endsWith("/admin/registration-codes")
      ) {
        return operatorLoggedIn
          ? jsonResponse(403, { error: { code: "forbidden" } })
          : jsonResponse(401, unauthorizedBody());
      }
      if (call.method === "POST" && call.url.endsWith("/admin/login")) {
        operatorLoggedIn = true;
        return jsonResponse(200, { role: "Operator" });
      }
      if (call.method === "GET" && call.url.endsWith("/admin/devices")) {
        return jsonResponse(200, {
          server_time: "2026-11-16T04:00:00.000Z",
          online_threshold_s: 60,
          items: [],
          truncated: false,
        });
      }
      throw new Error("Unerwarteter Aufruf: " + call.method + " " + call.url);
    });

    render(<App fetchImpl={operatorNet.fetchImpl} />);
    await screen.findByRole("heading", { name: "Anmeldung" });
    await operatorUser.type(screen.getByLabelText("Passwort"), "geheim");
    await operatorUser.click(screen.getByRole("button", { name: "Anmelden" }));

    expect(
      await screen.findByText("Die Aktion ist nicht erlaubt."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Zwei-Faktor-Einrichtung" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "TOTP einrichten" }),
    ).toBeNull();
    expect(operatorNet.posts("/admin/mfa/totp/setup")).toHaveLength(0);
  });
});
