import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { AdminShell } from "../admin/AdminShell";
import type { AdminSessionRole, FetchLike } from "../admin/adminApi";
import { DevicesPanel } from "./DevicesPanel";

afterEach(() => {
  cleanup();
});

interface Call {
  path: string;
  method: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function wireDevice(id: string, state: "active" | "revoked") {
  return {
    id,
    label: "SYN-" + id,
    manufacturer: "Acme",
    model: "M1",
    os_version: "14",
    sdk_int: 34,
    app_version: "1.2.3",
    app_flavor: "prod",
    state,
    registered_at: "2026-11-01T10:00:00Z",
    last_seen_at: "2026-11-13T08:00:00Z",
    connectivity: "reachable",
  };
}

/** Server-Double: Zustand je Geraet; POST .../revoke antwortet gemaess revokeAnswer. */
function createServer(states: Record<string, "active" | "revoked">, revokeAnswer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const path = String(input).replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (method === "GET" && path === "/admin/registration-codes") {
      return json(200, { items: [] });
    }
    if (method === "GET" && path === "/admin/devices") {
      return json(200, {
        server_time: "2026-11-13T08:00:00Z",
        online_threshold_s: 60,
        items: Object.entries(states).map(([id, state]) => wireDevice(id, state)),
      });
    }
    const detail = /^\/admin\/devices\/([^/]+)$/.exec(path);
    if (method === "GET" && detail !== null) {
      const id = detail[1] as string;
      return json(200, { ...wireDevice(id, states[id] ?? "active"), last_clock_offset_ms: 0, registration_code_id: null });
    }
    const revoke = /^\/admin\/devices\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revoke !== null) {
      return revokeAnswer();
    }
    throw new Error("Unerwarteter Aufruf: " + method + " " + path);
  };
  return {
    fetchImpl,
    calls,
    posts: () => calls.filter((call) => call.method === "POST"),
  };
}

function renderPanel(fetchImpl: FetchLike, role?: AdminSessionRole) {
  return render(
    <AdminShell fetchImpl={fetchImpl} {...(role === undefined ? {} : { role })}>
      <DevicesPanel />
    </AdminShell>,
  );
}

async function openDetail(user: ReturnType<typeof userEvent.setup>, id: string): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Details zu " + id }));
  await screen.findByText("SYN-" + id, { selector: "dd" });
}

function detailStatus(): string {
  const terms = screen.getAllByRole("term");
  const status = terms.find((term) => term.textContent === "Status");
  return status?.nextElementSibling?.textContent ?? "";
}

describe("CX-141 Identitaetswiderruf in der Geraeteansicht", () => {
  it("sendet beim Abbrechen keine Anfrage und laesst den Status unveraendert", async () => {
    const user = userEvent.setup();
    const server = createServer({ "dev-a": "active" }, () => new Response(null, { status: 204 }));
    renderPanel(server.fetchImpl);
    await openDetail(user, "dev-a");

    await user.click(screen.getByRole("button", { name: "Gerät sperren" }));
    const confirmation = screen.getByRole("group", { name: "Sperrbestätigung" });
    expect(confirmation.textContent).toContain("dev-a");
    expect(confirmation.textContent).toContain("durch ein späteres Aktivieren");
    await user.click(within(confirmation).getByRole("button", { name: "Abbrechen" }));

    expect(screen.queryByRole("group", { name: "Sperrbestätigung" })).toBeNull();
    expect(server.posts()).toHaveLength(0);
    expect(detailStatus()).toBe("Aktiv");
  });

  it("sendet nach Bestaetigung genau eine Anfrage und zeigt den Widerruf erst nach Erfolg", async () => {
    const user = userEvent.setup();
    const states: Record<string, "active" | "revoked"> = { "dev-a": "active" };
    let release: (response: Response) => void = () => undefined;
    const server = createServer(states, () => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    renderPanel(server.fetchImpl);
    await openDetail(user, "dev-a");

    await user.click(screen.getByRole("button", { name: "Gerät sperren" }));
    const confirm = within(screen.getByRole("group", { name: "Sperrbestätigung" })).getByRole("button", { name: "Sperren bestätigen" });
    await user.click(confirm);
    await user.click(confirm);

    await waitFor(() => expect(server.posts()).toHaveLength(1));
    expect(server.posts()[0]?.path).toBe("/admin/devices/dev-a/revoke");
    expect(detailStatus()).toBe("Aktiv");
    expect(screen.queryByText(/wurde vom Server gesperrt/)).toBeNull();

    states["dev-a"] = "revoked";
    release(new Response(null, { status: 204 }));
    await screen.findByText(/wurde vom Server gesperrt/);
    await waitFor(() => expect(detailStatus()).toBe("Gesperrt"));
    expect(server.posts()).toHaveLength(1);
  });

  it("erhaelt bei abgewiesener oder fehlgeschlagener Anfrage den Status und zeigt eine Meldung", async () => {
    const user = userEvent.setup();
    const answers = [json(403, { error: { code: "forbidden" } }), json(500, { error: "internal" })];
    const server = createServer({ "dev-a": "active" }, () => answers.shift() as Response);
    renderPanel(server.fetchImpl);
    await openDetail(user, "dev-a");
    await user.click(screen.getByRole("button", { name: "Gerät sperren" }));

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const group = screen.getByRole("group", { name: "Sperrbestätigung" });
      await user.click(within(group).getByRole("button", { name: "Sperren bestätigen" }));
      const alert = await within(group).findByRole("alert");
      expect((alert.textContent ?? "").length).toBeGreaterThan(10);
      expect(detailStatus()).toBe("Aktiv");
      expect(server.posts()).toHaveLength(attempt);
      expect(screen.queryByText(/wurde vom Server gesperrt/)).toBeNull();
    }
  });

  it("bietet nicht berechtigten Rollen und bereits widerrufenen Geraeten keine Widerrufsaktion", async () => {
    const user = userEvent.setup();
    const operator = createServer({ "dev-a": "active" }, () => new Response(null, { status: 204 }));
    renderPanel(operator.fetchImpl, "Operator");
    await openDetail(user, "dev-a");
    expect(screen.queryByRole("button", { name: "Gerät sperren" })).toBeNull();
    expect(operator.posts()).toHaveLength(0);
    cleanup();

    const admin = createServer({ "dev-r": "revoked" }, () => new Response(null, { status: 204 }));
    renderPanel(admin.fetchImpl);
    await openDetail(user, "dev-r");
    expect(detailStatus()).toBe("Gesperrt");
    expect(screen.queryByRole("button", { name: "Gerät sperren" })).toBeNull();
    expect(screen.getByText("Dieses Gerät ist bereits gesperrt.")).toBeTruthy();
    expect(admin.posts()).toHaveLength(0);
  });
});
