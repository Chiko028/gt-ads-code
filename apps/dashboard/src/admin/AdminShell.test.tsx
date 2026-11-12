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
import { afterEach, describe, expect, it } from "vitest";

import { AdminShell, useAdminSession } from "./AdminShell";
import type { FetchLike } from "./adminApi";

 (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(cleanup);

interface FetchCall {
  url: string;
  init: RequestInit;
}

type FetchHandler = (call: FetchCall) => Promise<Response>;

function createFetchDouble() {
  const calls: FetchCall[] = [];
  const queue: FetchHandler[] = [];

  const fetchImpl: FetchLike = (input, init) => {
    const call: FetchCall = { url: input, init: init ?? {} };
    calls.push(call);
    const handler = queue.shift();
    if (handler === undefined) {
      return Promise.reject(
        new Error("Unerwarteter Fetch-Aufruf: " + input),
      );
    }
    return handler(call);
  };

  return {
    fetchImpl,
    calls,
    enqueue(handler: FetchHandler) {
      queue.push(handler);
    },
    posts(urlSuffix: string) {
      return calls.filter(
        (call) =>
          call.init.method === "POST" && call.url.endsWith(urlSuffix),
      );
    },
    deletes() {
      return calls.filter((call) => call.init.method === "DELETE");
    },
    gets(urlSuffix: string) {
      return calls.filter(
        (call) =>
          (call.init.method ?? "GET") === "GET" &&
          call.url.endsWith(urlSuffix),
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

function apiError() {
  return {
    error: {
      code: "unauthorized",
      message: "SYN-Servermeldung mit internem Detail",
      request_id: "SYN-req-0001",
    },
  };
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const CODE_EXPIRES = "2026-11-12T22:00:00.000Z";

function codeItem(
  id: string,
  label: string | null,
  status: "pending" | "used" | "expired" | "revoked",
  expiresAt = CODE_EXPIRES,
) {
  return {
    id,
    label,
    created_at: "2026-11-12T21:00:00.000Z",
    expires_at: expiresAt,
    status,
  };
}

function ProtectedContent() {
  const { sessionStatus } = useAdminSession();
  return <p>Geschützter Inhalt ({sessionStatus})</p>;
}

function renderShell(net: ReturnType<typeof createFetchDouble>) {
  return render(
    <AdminShell fetchImpl={net.fetchImpl}>
      <ProtectedContent />
    </AdminShell>,
  );
}

describe("CX-026 AdminShell", () => {
  it("zeigt nach initialer 401 die Anmeldung, sendet nur das Passwort und meldet Fehler bereinigt", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    net.enqueue(async () => jsonResponse(401, apiError()));
    renderShell(net);

    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();

    const passwordField = () =>
      screen.getByLabelText("Passwort") as HTMLInputElement;
    const loginButton = () =>
      screen.getByRole("button", { name: "Anmelden" });

    net.enqueue(async () => jsonResponse(401, apiError()));
    await user.type(passwordField(), "falsch");
    await user.click(loginButton());

    expect(
      await screen.findByText(
        "Anmeldung fehlgeschlagen. Bitte das Passwort prüfen.",
      ),
    ).toBeTruthy();
    expect(passwordField().value).toBe("");
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();

    net.enqueue(async () =>
      jsonResponse(429, apiError(), { "Retry-After": "45" }),
    );
    await user.type(passwordField(), "falsch");
    await user.click(loginButton());

    expect(
      await screen.findByText(
        "Zu viele Versuche. Bitte in 45 Sekunden erneut versuchen.",
      ),
    ).toBeTruthy();
    expect(passwordField().value).toBe("");
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();

    net.enqueue(async () => emptyResponse(204));
    net.enqueue(async () => jsonResponse(200, { items: [] }));
    await user.type(passwordField(), "richtig");
    await user.click(loginButton());

    expect(
      await screen.findByRole("heading", { name: "Registrierungscodes" }),
    ).toBeTruthy();
    expect(
      await screen.findByText("Geschützter Inhalt (authenticated)"),
    ).toBeTruthy();
    await screen.findByText("Keine Registrierungscodes vorhanden.");

    const loginCalls = net.posts("/admin/login");
    expect(loginCalls).toHaveLength(3);
    for (const call of loginCalls) {
      expect(call.url).toBe("/v1/admin/login");
      expect(call.init.credentials).toBe("same-origin");
      expect(new Headers(call.init.headers).get("Content-Type")).toBe(
        "application/json",
      );
      const body = JSON.parse(String(call.init.body)) as Record<
        string,
        unknown
      >;
      expect(Object.keys(body)).toEqual(["password"]);
    }
    expect(JSON.parse(String(loginCalls[2]?.init.body))).toEqual({
      password: "richtig",
    });
  });

  it("erzeugt mit optionalem Label bis 64 Zeichen genau einen POST und zeigt den Klartext nur nach Erfolg", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    net.enqueue(async () => jsonResponse(200, { items: [] }));
    renderShell(net);

    await screen.findByText("Keine Registrierungscodes vorhanden.");
    const labelInput = screen.getByLabelText(
      "Bezeichnung (optional)",
    ) as HTMLInputElement;
    expect(labelInput.maxLength).toBe(64);

    const label64 = "A".repeat(64);
    await user.type(labelInput, label64);
    expect(labelInput.value).toBe(label64);

    const pendingCreate = deferredResponse();
    net.enqueue(() => pendingCreate.promise);
    const createButton = screen.getByRole("button", { name: "Code erzeugen" });
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(net.posts("/admin/registration-codes")).toHaveLength(1);
    });
    expect(screen.queryByText("SECRET-CODE-0001")).toBeNull();

    net.enqueue(async () =>
      jsonResponse(200, {
        items: [codeItem("c1", label64, "pending")],
      }),
    );
    await act(async () => {
      pendingCreate.resolve(
        jsonResponse(201, {
          id: "c1",
          code: "SECRET-CODE-0001",
          label: label64,
          expires_at: CODE_EXPIRES,
        }),
      );
    });

    expect(await screen.findByText("SECRET-CODE-0001")).toBeTruthy();
    const createdRegion = screen.getByRole("region", {
      name: "Erzeugter Registrierungscode",
    });
    expect(within(createdRegion).getByText(CODE_EXPIRES)).toBeTruthy();

    const createCalls = net.posts("/admin/registration-codes");
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(String(createCalls[0]?.init.body))).toEqual({
      label: label64,
    });

    await user.click(screen.getByRole("button", { name: "Ausblenden" }));
    expect(screen.queryByText("SECRET-CODE-0001")).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Erzeugter Registrierungscode" }),
    ).toBeNull();

    net.enqueue(async () =>
      jsonResponse(201, {
        id: "c2",
        code: "SECRET-CODE-0002",
        label: null,
        expires_at: "2026-11-12T22:10:00.000Z",
      }),
    );
    net.enqueue(async () => jsonResponse(200, { items: [] }));
    await user.click(screen.getByRole("button", { name: "Code erzeugen" }));
    expect(await screen.findByText("SECRET-CODE-0002")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Liste wird geladen …")).toBeNull();
    });

    net.enqueue(async () => emptyResponse(204));
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    await waitFor(() => {
      expect(screen.queryByText("SECRET-CODE-0002")).toBeNull();
    });
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
  });

  it("zeigt alle Codestatus an, widerruft nur pending und laedt nach 204 neu", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    net.enqueue(async () =>
      jsonResponse(200, {
        items: [
          codeItem("c1", "Handy A", "pending"),
          codeItem("c2", "Handy B", "used"),
          codeItem("c3", "Handy C", "expired"),
          codeItem("c4", "Handy D", "revoked"),
        ],
      }),
    );
    renderShell(net);

    expect(await screen.findByText("Offen")).toBeTruthy();
    expect(screen.getByText("Verwendet")).toBeTruthy();
    expect(screen.getByText("Abgelaufen")).toBeTruthy();
    expect(screen.getAllByText("Widerrufen")).toHaveLength(2);
    expect(screen.getAllByText(CODE_EXPIRES)).toHaveLength(4);
    expect(
      screen.getAllByRole("button", { name: "Widerrufen" }),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Widerrufen" }));
    expect(screen.getByText("Wirklich widerrufen?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText("Wirklich widerrufen?")).toBeNull();
    expect(net.deletes()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Widerrufen" }));
    net.enqueue(async () => emptyResponse(204));
    net.enqueue(async () =>
      jsonResponse(200, {
        items: [
          codeItem("c2", "Handy B", "used"),
          codeItem("c3", "Handy C", "expired"),
          codeItem("c4", "Handy D", "revoked"),
        ],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));

    await waitFor(() => {
      expect(net.deletes()).toHaveLength(1);
    });
    expect(net.deletes()[0]?.url).toBe("/v1/admin/registration-codes/c1");
    expect(net.deletes()[0]?.init.body).toBeUndefined();
    expect(
      new Headers(net.deletes()[0]?.init.headers).get("Content-Type"),
    ).toBe("application/json");

    await waitFor(() => {
      expect(net.gets("/admin/registration-codes")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("Handy A")).toBeNull();
    });
    expect(net.deletes()).toHaveLength(1);
    expect(
      screen.queryByText("Wirklich widerrufen?"),
    ).toBeNull();
  });

  it("entfernt bei Logout und Sitzungsablauf alle geschuetzten Inhalte und ignoriert verspaetete Antworten", async () => {
    const net = createFetchDouble();
    const user = userEvent.setup();
    net.enqueue(async () => jsonResponse(200, { items: [] }));
    renderShell(net);
    await screen.findByText("Keine Registrierungscodes vorhanden.");

    const pendingCreate = deferredResponse();
    net.enqueue(() => pendingCreate.promise);
    await user.type(screen.getByLabelText("Bezeichnung (optional)"), "Spät");
    await user.click(screen.getByRole("button", { name: "Code erzeugen" }));
    await waitFor(() => {
      expect(net.posts("/admin/registration-codes")).toHaveLength(1);
    });

    net.enqueue(async () => emptyResponse(204));
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(screen.queryByText("SECRET-LATE-0001")).toBeNull();

    await act(async () => {
      pendingCreate.resolve(
        jsonResponse(201, {
          id: "late",
          code: "SECRET-LATE-0001",
          label: "Spät",
          expires_at: "2026-11-12T23:00:00.000Z",
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("SECRET-LATE-0001")).toBeNull();
    });
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();

    async function login() {
      net.enqueue(async () => emptyResponse(204));
      net.enqueue(async () => jsonResponse(200, { items: [] }));
      await user.type(screen.getByLabelText("Passwort"), "geheim");
      await user.click(screen.getByRole("button", { name: "Anmelden" }));
      await screen.findByText("Keine Registrierungscodes vorhanden.");
    }

    await login();

    const pendingList = deferredResponse();
    const listCallsBefore = net.gets("/admin/registration-codes").length;
    net.enqueue(() => pendingList.promise);
    await user.click(screen.getByRole("button", { name: "Aktualisieren" }));
    await waitFor(() => {
      expect(net.gets("/admin/registration-codes")).toHaveLength(
        listCallsBefore + 1,
      );
    });

    net.enqueue(async () => emptyResponse(204));
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(
      await screen.findByRole("heading", { name: "Anmeldung" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();

    await act(async () => {
      pendingList.resolve(
        jsonResponse(200, {
          items: [codeItem("spaet", "Zu spät", "pending")],
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Zu spät")).toBeNull();
    });
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();

    await login();
    net.enqueue(async () => jsonResponse(401, apiError()));
    await user.click(screen.getByRole("button", { name: "Aktualisieren" }));

    expect(
      await screen.findByText(
        "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Registrierungscodes" }),
    ).toBeNull();

    await login();
    const logoutCallsBefore = net.posts("/admin/logout").length;
    net.enqueue(async () => {
      throw new Error("Netzwerk weg");
    });
    await user.click(screen.getByRole("button", { name: "Abmelden" }));

    expect(
      await screen.findByText(
        "Die Abmeldung konnte serverseitig nicht bestätigt werden. Bitte die Verbindung prüfen.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Geschützter Inhalt/)).toBeNull();
    await waitFor(() => {
      expect(net.posts("/admin/logout")).toHaveLength(logoutCallsBefore + 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(net.posts("/admin/logout")).toHaveLength(logoutCallsBefore + 1);
  });
});

