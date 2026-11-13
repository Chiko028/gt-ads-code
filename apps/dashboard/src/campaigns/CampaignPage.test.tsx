import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../admin/adminApi";
import { App } from "../App";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: originalCreateObjectURL,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: originalRevokeObjectURL,
    writable: true,
  });
});

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface WireCampaign {
  id: string;
  customer_id: string;
  media_id: string;
  rule_type: string;
  status: string;
  archived: boolean;
  start_at: string;
  end_at: string;
  taxi_ids: string[];
  group_ids: string[];
  revision: number;
  created_at: string;
  updated_at: string;
}

interface WireCustomer {
  id: string;
  display_name: string;
}

interface WireMedia {
  id: string;
  display_name: string;
  size_bytes: number;
  sha256: string;
  status: string;
}

type PatchHandler = (call: FetchCall) => Response | Promise<Response>;
type DetailHandler = (id: string) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status });
}

function bodyOf(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

function wireCampaign(overrides: Partial<WireCampaign> = {}): WireCampaign {
  return {
    id: "campaign-1",
    customer_id: "cust-1",
    media_id: "med-1",
    rule_type: "fixed_slot",
    status: "draft",
    archived: false,
    start_at: "2026-12-01T10:00:00.000Z",
    end_at: "2026-12-02T10:00:00.000Z",
    taxi_ids: ["taxi-1"],
    group_ids: ["gruppe-1"],
    revision: 1,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function wireCustomer(id: string, name: string): WireCustomer {
  return { id, display_name: name };
}

function wireMedia(
  id: string,
  name: string,
  sha256 = "ab".repeat(32),
): WireMedia {
  return {
    id,
    display_name: name,
    size_bytes: 3,
    sha256,
    status: "ready",
  };
}

interface ServerOptions {
  readonly campaigns?: WireCampaign[];
  readonly customers?: WireCustomer[];
  readonly media?: WireMedia[];
  readonly unauthorizedCampaigns?: boolean;
  readonly detailHandler?: DetailHandler;
  readonly patchHandler?: PatchHandler;
}

function createServer(options: ServerOptions = {}) {
  let authenticated = true;
  const campaigns: WireCampaign[] = (options.campaigns ?? []).map((item) => ({
    ...item,
  }));
  const customers = options.customers ?? [wireCustomer("cust-1", "Kunde Eins")];
  const media = options.media ?? [wireMedia("med-1", "Spot Eins")];
  const calls: FetchCall[] = [];
  let detailHandler = options.detailHandler;
  let patchHandler = options.patchHandler;

  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = bodyOf(init);
    calls.push({ url, method, body });

    if (method === "POST" && url.endsWith("/admin/login")) {
      authenticated = true;
      return empty();
    }
    if (method === "POST" && url.endsWith("/admin/logout")) {
      authenticated = false;
      return empty();
    }
    if (!authenticated) {
      return json(401, { error: { code: "unauthorized" } });
    }
    if (method === "GET" && url.endsWith("/admin/registration-codes")) {
      return json(200, { items: [] });
    }

    if (method === "GET" && url.endsWith("/admin/campaigns")) {
      if (options.unauthorizedCampaigns === true) {
        return json(401, { error: { code: "unauthorized" } });
      }
      return json(200, { items: campaigns });
    }
    if (method === "GET" && url.endsWith("/admin/customers")) {
      return json(200, { items: customers });
    }
    if (method === "GET" && url.endsWith("/admin/media")) {
      return json(200, { items: media });
    }

    if (method === "POST" && url.endsWith("/admin/campaigns")) {
      const record = (body ?? {}) as Record<string, unknown>;
      const created = wireCampaign({
        id: "created-campaign",
        customer_id: String(record.customer_id ?? ""),
        media_id: String(record.media_id ?? ""),
        start_at: String(record.start_at ?? ""),
        end_at: String(record.end_at ?? ""),
        taxi_ids: Array.isArray(record.taxi_ids)
          ? (record.taxi_ids as string[])
          : [],
        group_ids: Array.isArray(record.group_ids)
          ? (record.group_ids as string[])
          : [],
      });
      campaigns.push(created);
      return json(201, created);
    }

    const campaignMatch = /\/admin\/campaigns\/([^/?]+)$/.exec(url);
    if (campaignMatch !== null) {
      const id = decodeURIComponent(campaignMatch[1] ?? "");
      if (method === "GET") {
        if (detailHandler !== undefined) {
          return detailHandler(id);
        }
        const found = campaigns.find((item) => item.id === id);
        return found === undefined
          ? json(404, { error: { code: "not_found" } })
          : json(200, found);
      }
      if (method === "PATCH") {
        if (patchHandler !== undefined) {
          return patchHandler({ url, method, body });
        }
        const index = campaigns.findIndex((item) => item.id === id);
        if (index < 0) {
          return json(404, { error: { code: "not_found" } });
        }
        const current = campaigns[index] as WireCampaign;
        const record = (body ?? {}) as Record<string, unknown>;
        if (record.revision !== current.revision) {
          return json(400, { error: { code: "invalid_request" } });
        }
        const updated: WireCampaign = {
          ...current,
          status:
            typeof record.status === "string" ? record.status : current.status,
          archived:
            typeof record.archived === "boolean"
              ? record.archived
              : current.archived,
          media_id:
            typeof record.media_id === "string"
              ? record.media_id
              : current.media_id,
          start_at:
            typeof record.start_at === "string"
              ? record.start_at
              : current.start_at,
          end_at:
            typeof record.end_at === "string"
              ? record.end_at
              : current.end_at,
          revision: current.revision + 1,
          updated_at: "2026-11-13T12:00:00.000Z",
        };
        if (Array.isArray(record.taxi_ids)) {
          updated.taxi_ids = record.taxi_ids as string[];
        }
        if (Array.isArray(record.group_ids)) {
          updated.group_ids = record.group_ids as string[];
        }
        campaigns[index] = updated;
        return json(200, updated);
      }
    }

    return json(404, { error: { code: "not_found" } });
  };

  return {
    fetchImpl,
    calls,
    postCalls(): FetchCall[] {
      return calls.filter(
        (call) =>
          call.method === "POST" && call.url.endsWith("/admin/campaigns"),
      );
    },
    patchCalls(): FetchCall[] {
      return calls.filter((call) => call.method === "PATCH");
    },
    detailGets(): FetchCall[] {
      return calls.filter(
        (call) =>
          call.method === "GET" && /\/admin\/campaigns\/[^/?]+$/.test(call.url),
      );
    },
    setPatchHandler(handler: PatchHandler) {
      patchHandler = handler;
    },
    setDetailHandler(handler: DetailHandler) {
      detailHandler = handler;
    },
  };
}

async function openCampaigns(server: ReturnType<typeof createServer>) {
  window.history.replaceState(null, "", "#/kampagnen");
  const view = render(<App fetchImpl={server.fetchImpl} />);
  await screen.findByRole("heading", { name: "Kampagnen" });
  const region = await screen.findByRole("region", { name: "Kampagnen" });
  return { view, region };
}

async function waitForTable(region: HTMLElement) {
  return within(region).findByRole("table");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function bytesFromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function stubDigest(hex: string) {
  const bytes = bytesFromHex(hex);
  const digest = vi.fn(
    async (
      _algorithm: AlgorithmIdentifier,
      _data: BufferSource,
    ): Promise<ArrayBuffer> => arrayBufferOf(bytes),
  );
  vi.stubGlobal("crypto", { subtle: { digest } });
  return digest;
}

function stubObjectUrls() {
  const create = vi.fn((_file: Blob) => "blob:preview-" + create.mock.calls.length);
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: create,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revoke,
    writable: true,
  });
  return { create, revoke };
}

describe("CX-040 Kampagnenseite", () => {
  it("legt ueber die echte App eine Kampagne an und sendet bei Doppelklick nur einmal", async () => {
    const server = createServer();
    const user = userEvent.setup();
    const { region } = await openCampaigns(server);

    await user.click(
      within(region).getByRole("button", { name: "Neue Kampagne" }),
    );

    await user.selectOptions(within(region).getByLabelText("Kunde"), "cust-1");
    await user.selectOptions(within(region).getByLabelText("Medium"), "med-1");

    await user.type(
      within(region).getByLabelText(/Laufzeitbeginn/),
      "2026-12-01T10:00:00.000Z",
    );
    await user.type(
      within(region).getByLabelText(/Laufzeitende/),
      "2026-12-02T10:00:00.000Z",
    );

    expect(
      within(region).getByText(/Ein Taxi umfasst beide Tablets/),
    ).toBeTruthy();

    await user.type(
      within(region).getByLabelText("Weiteres Taxi-Ziel"),
      "taxi-1",
    );
    await user.click(
      within(region).getByRole("button", { name: "Taxi-Ziel hinzufügen" }),
    );
    await user.type(
      within(region).getByLabelText("Weiteres Gruppen-Ziel"),
      "gruppe-1",
    );
    await user.click(
      within(region).getByRole("button", { name: "Gruppen-Ziel hinzufügen" }),
    );

    expect(
      (within(region).getByLabelText("Taxiziele") as HTMLSelectElement).value,
    ).toBe("taxi-1");
    expect(
      (within(region).getByLabelText("Gruppenziele") as HTMLSelectElement).value,
    ).toBe("gruppe-1");

    const formElement = within(region)
      .getByRole("button", { name: "Kampagne anlegen" })
      .closest("form");
    expect(formElement).not.toBeNull();

    await act(async () => {
      fireEvent.submit(formElement as HTMLFormElement);
      fireEvent.submit(formElement as HTMLFormElement);
    });

    await waitFor(() => expect(server.postCalls()).toHaveLength(1));
    expect(server.postCalls()[0]?.body).toEqual({
      customer_id: "cust-1",
      media_id: "med-1",
      start_at: "2026-12-01T10:00:00.000Z",
      end_at: "2026-12-02T10:00:00.000Z",
      taxi_ids: ["taxi-1"],
      group_ids: ["gruppe-1"],
    });

    await screen.findByText("Kampagne angelegt.");
    const table = await waitForTable(region);
    expect(within(table).getByText("Kunde Eins")).toBeTruthy();
    expect(
      server.calls.some((call) => call.url.includes("/taxis/")),
    ).toBe(false);
  });

  const TRANSITIONS = [
    {
      label: "Entwurf aktivieren",
      status: "draft",
      button: "Aktivieren",
      expected: { status: "active" },
      revision: 1,
    },
    {
      label: "Aktive Kampagne pausieren",
      status: "active",
      button: "Pausieren",
      expected: { status: "paused" },
      revision: 2,
    },
    {
      label: "Pausierte Kampagne fortsetzen",
      status: "paused",
      button: "Fortsetzen",
      expected: { status: "active" },
      revision: 3,
    },
    {
      label: "Aktive Kampagne beenden",
      status: "active",
      button: "Beenden",
      expected: { status: "finished" },
      revision: 2,
      confirm: "Wirklich beenden?",
    },
    {
      label: "Beendete Kampagne archivieren",
      status: "finished",
      button: "Archivieren",
      expected: { archived: true },
      revision: 4,
      confirm: "Wirklich archivieren?",
    },
  ] as const;

  it.each(TRANSITIONS)(
    "fuehrt die Statusaktion aus: $label",
    async (testCase) => {
      const server = createServer({
        campaigns: [
          wireCampaign({
            status: testCase.status,
            revision: testCase.revision,
          }),
        ],
      });
      const user = userEvent.setup();
      const { region } = await openCampaigns(server);
      const table = await waitForTable(region);
      const row = within(table).getByText("Kunde Eins").closest("tr");
      expect(row).not.toBeNull();

      await user.click(
        within(row as HTMLElement).getByRole("button", {
          name: testCase.button,
        }),
      );

      if ("confirm" in testCase) {
        expect(
          within(row as HTMLElement).getByText(testCase.confirm),
        ).toBeTruthy();
        await user.click(
          within(row as HTMLElement).getByRole("button", {
            name: "Bestätigen",
          }),
        );
      }

      await waitFor(() => expect(server.patchCalls()).toHaveLength(1));
      expect(server.patchCalls()[0]?.body).toEqual({
        ...testCase.expected,
        revision: testCase.revision,
      });
    },
  );

  it("sendet bei Abbruch nichts und laesst den Zustand nach einem Serverfehler unveraendert", async () => {
    const server = createServer({
      campaigns: [wireCampaign({ status: "draft", revision: 1 })],
    });
    const user = userEvent.setup();
    const { region } = await openCampaigns(server);
    const table = await waitForTable(region);
    const row = within(table).getByText("Kunde Eins").closest("tr");
    expect(row).not.toBeNull();

    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Beenden" }),
    );
    expect(
      within(row as HTMLElement).getByText("Wirklich beenden?"),
    ).toBeTruthy();
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Abbrechen" }),
    );
    expect(server.patchCalls()).toHaveLength(0);

    server.setPatchHandler(() => json(500, { error: { code: "internal_error" } }));
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Aktivieren" }),
    );

    await screen.findByText(/Der Server hat einen Fehler gemeldet/);
    expect(server.patchCalls()).toHaveLength(1);
    expect(within(row as HTMLElement).getByText("Entwurf")).toBeTruthy();
    expect(within(row as HTMLElement).queryByText("Aktiv")).toBeNull();
  });

  it("akzeptiert nur die lokale Originaldatei mit passendem SHA-256 und gibt Object-URLs frei", async () => {
    const hash = "ab".repeat(32);
    const server = createServer({
      media: [
        wireMedia("med-1", "Spot Eins", hash),
        wireMedia("med-2", "Spot Zwei", hash),
      ],
    });
    const digest = stubDigest(hash);
    const urls = stubObjectUrls();
    const user = userEvent.setup();
    const { region } = await openCampaigns(server);

    await user.click(
      within(region).getByRole("button", { name: "Neue Kampagne" }),
    );
    await user.selectOptions(within(region).getByLabelText("Medium"), "med-1");

    expect(
      within(region).getByLabelText(
        "Lokale Originaldatei für Vorschau auswählen",
      ),
    ).toBeTruthy();

    const file = new File([new Uint8Array([1, 2, 3])], "original.mp4", {
      type: "video/mp4",
    });
    await user.upload(
      within(region).getByLabelText("Lokale Originaldatei für Vorschau auswählen"),
      file,
    );

    const video = await within(region).findByTestId("media-preview");
    expect(video.tagName).toBe("VIDEO");
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect((video as HTMLVideoElement).autoplay).toBe(false);
    expect((video as HTMLVideoElement).controls).toBe(true);
    expect(digest).toHaveBeenCalledWith("SHA-256", expect.anything());
    expect(urls.create).toHaveBeenCalledTimes(1);

    await user.selectOptions(within(region).getByLabelText("Medium"), "med-2");
    await waitFor(() =>
      expect(urls.revoke).toHaveBeenCalledWith("blob:preview-1"),
    );
    expect(within(region).queryByTestId("media-preview")).toBeNull();

    await user.upload(
      within(region).getByLabelText("Lokale Originaldatei für Vorschau auswählen"),
      file,
    );
    await within(region).findByTestId("media-preview");

    cleanup();
    expect(urls.revoke).toHaveBeenCalledWith("blob:preview-2");
  });

  it("weist eine Datei mit falschem Hash und eine zu grosse Datei zurueck", async () => {
    const hash = "ab".repeat(32);
    const server = createServer({
      media: [wireMedia("med-1", "Spot Eins", hash)],
    });
    stubDigest("cd".repeat(32));
    stubObjectUrls();
    const user = userEvent.setup();
    const { region } = await openCampaigns(server);

    await user.click(
      within(region).getByRole("button", { name: "Neue Kampagne" }),
    );
    await user.selectOptions(within(region).getByLabelText("Medium"), "med-1");

    await user.upload(
      within(region).getByLabelText("Lokale Originaldatei für Vorschau auswählen"),
      new File([new Uint8Array([9])], "falsch.mp4", { type: "video/mp4" }),
    );
    await within(region).findByText(/SHA-256 stimmt nicht überein/);
    expect(within(region).queryByTestId("media-preview")).toBeNull();

    const huge = new File([new Uint8Array([1])], "riesig.mp4", {
      type: "video/mp4",
    });
    Object.defineProperty(huge, "size", { value: 20_000_001 });
    await user.upload(
      within(region).getByLabelText("Lokale Originaldatei für Vorschau auswählen"),
      huge,
    );
    await within(region).findByText(/Die Datei ist zu groß/);
    expect(within(region).queryByTestId("media-preview")).toBeNull();
  });

  it("beendet die Seite bei abgelaufener Sitzung ohne veraltete Kampagnen", async () => {
    const server = createServer({ unauthorizedCampaigns: true });
    window.history.replaceState(null, "", "#/kampagnen");
    render(<App fetchImpl={server.fetchImpl} />);

    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("region", { name: "Kampagnen" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("verwirft beim schnellen Kampagnenwechsel die spaetere Antwort der alten Auswahl", async () => {
    const server = createServer({
      campaigns: [
        wireCampaign({ id: "campaign-a", customer_id: "cust-a" }),
        wireCampaign({ id: "campaign-b", customer_id: "cust-b" }),
      ],
      customers: [
        wireCustomer("cust-a", "Kunde A"),
        wireCustomer("cust-b", "Kunde B"),
        wireCustomer("cust-1", "Kunde Eins"),
      ],
    });
    const first = deferred<Response>();
    const second = deferred<Response>();
    const detailHandler = (id: string): Promise<Response> =>
      id === "campaign-a" ? first.promise : second.promise;
    server.setDetailHandler(detailHandler);

    const user = userEvent.setup();
    const { region } = await openCampaigns(server);
    const table = await waitForTable(region);
    const rows = within(table).getAllByRole("row");
    const rowA = rows.find((row) => row.textContent?.includes("Kunde A"));
    const rowB = rows.find((row) => row.textContent?.includes("Kunde B"));
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    await user.click(
      within(rowA as HTMLElement).getByRole("button", { name: "Bearbeiten" }),
    );
    await user.click(
      within(rowB as HTMLElement).getByRole("button", { name: "Bearbeiten" }),
    );

    await act(async () => {
      second.resolve(
        json(
          200,
          wireCampaign({ id: "campaign-b", customer_id: "cust-b", revision: 1 }),
        ),
      );
    });

    const customerSelect = (await within(region).findByLabelText(
      "Kunde",
    )) as HTMLSelectElement;
    await waitFor(() => expect(customerSelect.value).toBe("cust-b"));

    await act(async () => {
      first.resolve(
        json(
          200,
          wireCampaign({ id: "campaign-a", customer_id: "cust-a", revision: 1 }),
        ),
      );
    });
    await waitFor(() => expect(customerSelect.value).toBe("cust-b"));
  });

  it("laedt bei einem Versionskonflikt neu und verlangt bewusstes erneutes Bearbeiten", async () => {
    const server = createServer({
      campaigns: [wireCampaign({ status: "draft", revision: 1 })],
    });
    server.setPatchHandler(() =>
      json(400, { error: { code: "invalid_request" } }),
    );

    const user = userEvent.setup();
    const { region } = await openCampaigns(server);
    const table = await waitForTable(region);
    await user.click(
      within(table).getByRole("button", { name: "Bearbeiten" }),
    );

    await within(region).findByRole("button", { name: "Änderungen speichern" });
    await user.click(
      within(region).getByRole("button", { name: "Änderungen speichern" }),
    );

    await within(region).findByText(/inzwischen geändert/);
    expect(server.patchCalls()).toHaveLength(1);
    expect(
      within(region).queryByRole("button", { name: "Änderungen speichern" }),
    ).toBeNull();

    // Erst eine neue, bewusste Bearbeitung oeffnet das Formular wieder.
    await user.click(
      within(await waitForTable(region)).getByRole("button", {
        name: "Bearbeiten",
      }),
    );
    await within(region).findByRole("button", { name: "Änderungen speichern" });
  });
});

