import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import type { FetchLike } from "../admin/adminApi";
import type {
  UploadAbortHandle,
  UploadCompletion,
  UploadProgress,
  UploadTransport,
  UploadTransportCallbacks,
  UploadXhrLike,
  XhrProgressEventLike,
} from "./uploadTransport";
import { MEDIA_UPLOAD_PROFILE_MAX_BYTES } from "./MediaPage";
import { createXhrUploadTransport } from "./uploadTransport";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
});

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

type ListHandler = (index: number) => Response | Promise<Response>;

interface Server {
  readonly fetchImpl: FetchLike;
  readonly calls: FetchCall[];
  listCalls(): number;
  setListHandler(handler: ListHandler): void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status });
}

function createServer(
  options: { authenticated?: boolean; list?: ListHandler } = {},
): Server {
  let authenticated = options.authenticated ?? true;
  let listHandler: ListHandler =
    options.list ?? (() => json(200, { items: [] }));
  let listCount = 0;
  const calls: FetchCall[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });

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
    if (method === "GET" && url.endsWith("/admin/media")) {
      const index = listCount++;
      return listHandler(index);
    }
    return json(404, { error: { code: "not_found" } });
  };

  return {
    fetchImpl,
    calls,
    listCalls() {
      return listCount;
    },
    setListHandler(handler: ListHandler) {
      listHandler = handler;
    },
  };
}

class FakeTransport implements UploadTransport {
  readonly calls: Array<{
    readonly file: File;
    readonly callbacks: UploadTransportCallbacks;
  }> = [];
  aborts = 0;

  upload(file: File, callbacks: UploadTransportCallbacks): UploadAbortHandle {
    this.calls.push({ file, callbacks });
    return {
      abort: () => {
        this.aborts += 1;
      },
    };
  }

  last() {
    return this.calls[this.calls.length - 1];
  }
}

/** Datei mit exakt gewuenschter Groesse, ohne die Grenze wirklich zu allokieren. */
function mediaFile(name: string, size: number): File {
  const file = new File([new Uint8Array(4)], name, { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function wireItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "med-1",
    name: "spot.mp4",
    size_bytes: 12345,
    status: "ready",
    profile: { duration_seconds: 12.5 },
    ...overrides,
  };
}

function uploadResult(name = "spot.mp4"): string {
  return JSON.stringify({
    id: "med-uploaded",
    name,
    size_bytes: 42,
    sha256: "SyntheticDigest",
    profile: {
      container: "mp4",
      video_codec: "h264",
      width: 640,
      height: 360,
      frame_rate_numerator: 25,
      frame_rate_denominator: 1,
      audio_stream_count: 1,
      duration_seconds: 10,
    },
  });
}

async function openMediaPage(server: Server, transport: UploadTransport) {
  window.history.replaceState(null, "", "#/medien");
  const view = render(
    <App fetchImpl={server.fetchImpl} uploadTransport={transport} />,
  );
  await screen.findByRole("heading", { name: "Medien" });
  const region = screen.getByRole("region", { name: "Medien" });
  return { view, region };
}

async function chooseFile(
  region: HTMLElement,
  file: File,
): Promise<void> {
  const user = userEvent.setup();
  await user.upload(within(region).getByLabelText("Datei"), file);
}

function submit(region: HTMLElement): void {
  const form = region.querySelector("form");
  if (form === null) {
    throw new Error("Uploadformular fehlt.");
  }
  fireEvent.submit(form);
}

describe("CX-039 Medienseite", () => {
  it("zeigt die Medienseite nur mit Sitzung und verwirft nach Abmeldung Daten und spaete Antworten", async () => {
    const anonymousServer = createServer({ authenticated: false });
    window.history.replaceState(null, "", "#/medien");
    render(
      <App
        fetchImpl={anonymousServer.fetchImpl}
        uploadTransport={new FakeTransport()}
      />,
    );
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("region", { name: "Medien" })).toBeNull();
    expect(screen.queryByLabelText("Datei")).toBeNull();
    expect(anonymousServer.listCalls()).toBe(0);
    cleanup();

    let resolveList!: (response: Response) => void;
    const server = createServer({
      list: () =>
        new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    });
    const transport = new FakeTransport();
    await openMediaPage(server, transport);
    await screen.findByText("Medien werden geladen …");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByRole("heading", { name: "Anmeldung" });

    await act(async () => {
      resolveList(json(200, { items: [wireItem()] }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Medien" })).toBeNull();
    });
    expect(screen.queryByText("spot.mp4")).toBeNull();
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeTruthy();
  });

  it("unterscheidet Laden, leere Liste und Ladefehler", async () => {
    let resolveList!: (response: Response) => void;
    const server = createServer({
      list: () =>
        new Promise<Response>((resolve) => {
          resolveList = resolve;
        }),
    });
    await openMediaPage(server, new FakeTransport());

    await screen.findByText("Medien werden geladen …");
    expect(screen.queryByText("Keine Medien vorhanden.")).toBeNull();

    await act(async () => {
      resolveList(json(200, { items: [] }));
      await Promise.resolve();
    });
    await screen.findByText("Keine Medien vorhanden.");
    expect(screen.queryByText("Medien werden geladen …")).toBeNull();
    cleanup();

    const failingServer = createServer({
      list: () => json(500, { error: { code: "internal_error" } }),
    });
    await openMediaPage(failingServer, new FakeTransport());
    await screen.findByText("Die Medienliste konnte nicht geladen werden.");
    expect(screen.queryByText("Keine Medien vorhanden.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("zeigt Medienkennung, Dateiname, Groesse, Dauer und Pruefstatus aus der Serverantwort", async () => {
    const server = createServer({
      list: () => json(200, { items: [wireItem()] }),
    });
    await openMediaPage(server, new FakeTransport());

    await screen.findByText("med-1");
    expect(screen.getByText("spot.mp4")).toBeTruthy();
    expect(screen.getByText("12345 Bytes")).toBeTruthy();
    expect(screen.getByText("12.5 s")).toBeTruthy();
    expect(screen.getByText("Geprüft")).toBeTruthy();
    // Keine Browserannahme: der Serverstatus wird nur angezeigt.
    expect(screen.queryByText(/Erfolgreich/i)).toBeNull();
  });

  it("sendet genau einen Upload, zeigt messbaren Fortschritt, dann die Serverpruefung und laedt erst nach Erfolg neu", async () => {
    const server = createServer({
      list: (index) =>
        index === 0
          ? json(200, { items: [] })
          : json(200, { items: [wireItem()] }),
    });
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await screen.findByText("Keine Medien vorhanden.");

    const file = mediaFile("spot.mp4", 42);
    await chooseFile(region, file);
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));

    expect(transport.calls).toHaveLength(1);
    expect(transport.last()?.file).toBe(file);
    expect(server.listCalls()).toBe(1);
    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }

    act(() => {
      callbacks.onProgress?.({
        lengthComputable: true,
        loaded: 21,
        total: 42,
      });
    });
    expect(within(region).getByText("50 % übertragen")).toBeTruthy();
    expect(within(region).queryByText("Wird geprüft …")).toBeNull();

    act(() => {
      callbacks.onProgress?.({
        lengthComputable: true,
        loaded: 42,
        total: 42,
      });
    });
    expect(within(region).getByText("Wird geprüft …")).toBeTruthy();
    expect(within(region).queryByText(/Upload bestätigt/)).toBeNull();
    // Noch keine Antwort: die Liste wird nicht vorzeitig neu geladen.
    expect(server.listCalls()).toBe(1);

    await act(async () => {
      callbacks.onComplete?.({
        status: 201,
        responseText: uploadResult(),
      });
      await Promise.resolve();
    });

    await screen.findByText(/Upload bestätigt: spot.mp4/);
    await waitFor(() => {
      expect(server.listCalls()).toBe(2);
    });
    await screen.findByText("med-1");
    expect(transport.calls).toHaveLength(1);
  });

  it("weist Uebergroesse vor dem Versand ab und laesst exakt die CX-155-Profilgrenze zu", async () => {
    const server = createServer();
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);

    await chooseFile(region, mediaFile("zu-gross.mp4", MEDIA_UPLOAD_PROFILE_MAX_BYTES + 1));
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));

    expect(transport.calls).toHaveLength(0);
    const oversizeAlert = within(region).getByRole("alert");
    expect(oversizeAlert.textContent).toMatch(/zu groß/i);
    expect(MEDIA_UPLOAD_PROFILE_MAX_BYTES).toBe(1_000_000_000);
    expect(oversizeAlert.textContent).toContain("1.000.000.000");
    expect(within(region).queryByText(/Upload bestätigt/)).toBeNull();
    cleanup();

    const boundaryServer = createServer();
    const boundaryTransport = new FakeTransport();
    const boundary = await openMediaPage(boundaryServer, boundaryTransport);
    await chooseFile(
      boundary.region,
      mediaFile("grenze.mp4", MEDIA_UPLOAD_PROFILE_MAX_BYTES),
    );
    await userEvent
      .setup()
      .click(within(boundary.region).getByRole("button", { name: "Hochladen" }));
    expect(boundaryTransport.calls).toHaveLength(1);
  });

  it("verhindert einen zweiten Request bei Doppelklick waehrend des Uploads", async () => {
    const server = createServer();
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await chooseFile(region, mediaFile("spot.mp4", 42));

    submit(region);
    submit(region);

    expect(transport.calls).toHaveLength(1);
  });

  it.each([
    [413, /413/],
    [415, /Dateityp/],
    [422, /Medienformat/],
  ])(
    "zeigt den Serverfehler %i verstaendlich ohne Erfolg oder Wiederholung",
    async (status, pattern) => {
      const server = createServer();
      const transport = new FakeTransport();
      const { region } = await openMediaPage(server, transport);
      await chooseFile(region, mediaFile("spot.mp4", 42));
      const user = userEvent.setup();
      await user.click(
        within(region).getByRole("button", { name: "Hochladen" }),
      );

      const callbacks = transport.last()?.callbacks;
      if (callbacks === undefined) {
        throw new Error("Transportaufruf fehlt.");
      }
      await act(async () => {
        callbacks.onComplete?.({
          status,
          responseText: JSON.stringify({ error: { code: "rejected" } }),
        });
        await Promise.resolve();
      });

      const alert = await within(region).findByRole("alert");
      expect(alert.textContent).toMatch(pattern);
      expect(within(region).queryByText(/Upload bestätigt/)).toBeNull();
      expect(transport.calls).toHaveLength(1);
      // Kein automatisches Nachladen und kein Wiederholungsupload.
      expect(server.listCalls()).toBe(1);
    },
  );

  it("behandelt unklare Transportausgaenge ohne erfundenen Erfolg und ohne Wiederholung", async () => {
    const server = createServer();
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await chooseFile(region, mediaFile("spot.mp4", 42));
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));

    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }
    await act(async () => {
      callbacks.onError?.("network");
      await Promise.resolve();
    });

    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toMatch(/unklar/i);
    expect(alert.textContent).toMatch(/nicht automatisch wiederholt/i);
    expect(within(region).queryByText(/Upload bestätigt/)).toBeNull();
    expect(transport.calls).toHaveLength(1);
    expect(server.listCalls()).toBe(1);
  });

  it("trennt ein fehlgeschlagenes Nachladen vom bestaetigten Upload", async () => {
    const server = createServer({
      list: (index) =>
        index === 0
          ? json(200, { items: [] })
          : json(500, { error: { code: "internal_error" } }),
    });
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await chooseFile(region, mediaFile("spot.mp4", 42));
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));

    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }
    await act(async () => {
      callbacks.onComplete?.({
        status: 201,
        responseText: uploadResult(),
      });
      await Promise.resolve();
    });

    await screen.findByText(/Upload bestätigt/);
    await screen.findByText(
      "Der Upload wurde bestätigt, aber die Medienliste konnte nicht aktualisiert werden.",
    );
    expect(screen.getByText(/Upload bestätigt: spot.mp4/)).toBeTruthy();
    expect(screen.getByText("Die Medienliste konnte nicht geladen werden.")).toBeTruthy();
  });

  it("invalidiert die vorhandene Sitzung bei 401 aus dem Upload", async () => {
    const server = createServer();
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await chooseFile(region, mediaFile("spot.mp4", 42));
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));

    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }
    await act(async () => {
      callbacks.onComplete?.({
        status: 401,
        responseText: JSON.stringify({ error: { code: "unauthorized" } }),
      });
      await Promise.resolve();
    });

    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("region", { name: "Medien" })).toBeNull();
    expect(screen.queryByText(/Upload bestätigt/)).toBeNull();
  });

  it("bricht bei Abmeldung ab und ignoriert die spaete Uploadantwort", async () => {
    const server = createServer();
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await chooseFile(region, mediaFile("spot.mp4", 42));
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));
    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }

    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(transport.aborts).toBe(1);

    await act(async () => {
      callbacks.onComplete?.({
        status: 201,
        responseText: uploadResult(),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Medien" })).toBeNull();
    });
    expect(screen.queryByText(/Upload bestätigt/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeTruthy();
  });

  it("zeigt ohne lengthComputable keinen Prozentwert, sondern unbestimmten Fortschritt", async () => {
    const server = createServer();
    const transport = new FakeTransport();
    const { region } = await openMediaPage(server, transport);
    await chooseFile(region, mediaFile("spot.mp4", 42));
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Hochladen" }));
    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }

    act(() => {
      callbacks.onProgress?.({
        lengthComputable: false,
        loaded: 10,
        total: 0,
      });
    });
    expect(
      within(region).getByText("Wird hochgeladen … (Fortschritt unbekannt)"),
    ).toBeTruthy();
    expect(within(region).queryByText(/% übertragen/)).toBeNull();

    act(() => {
      callbacks.onUploaded?.();
    });
    expect(within(region).getByText("Wird geprüft …")).toBeTruthy();
    expect(within(region).queryByText(/Upload bestätigt/)).toBeNull();
  });
});

class FakeXhr {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 201;
  responseText = JSON.stringify({ id: "med-1" });
  withCredentials = false;
  aborted = false;
  upload: {
    onprogress: ((event: XhrProgressEventLike) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: unknown): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
  }
}

describe("CX-039 XHR-Transport", () => {
  it("bildet das CX-031-Uploadformat genau einmal ab", () => {
    const xhr = new FakeXhr();
    const transport = createXhrUploadTransport({
      xhrFactory: () => xhr as unknown as UploadXhrLike,
    });
    const progress: UploadProgress[] = [];
    const completions: UploadCompletion[] = [];
    let uploaded = 0;
    const file = mediaFile("spot one.mp4", 42);

    transport.upload(file, {
      onProgress: (event) => progress.push(event),
      onUploaded: () => {
        uploaded += 1;
      },
      onComplete: (result) => completions.push(result),
    });

    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/v1/admin/media?name=spot%20one.mp4");
    expect(xhr.headers["Content-Type"]).toBe("application/octet-stream");
    expect(xhr.headers.Accept).toBe("application/json");
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.body).toBe(file);

    xhr.upload.onprogress?.({
      lengthComputable: true,
      loaded: 21,
      total: 42,
    });
    xhr.upload.onprogress?.({
      lengthComputable: false,
      loaded: 42,
      total: 0,
    });
    xhr.upload.onload?.();
    xhr.onload?.();

    expect(progress).toEqual([
      { lengthComputable: true, loaded: 21, total: 42 },
      { lengthComputable: false, loaded: 42, total: 0 },
    ]);
    expect(uploaded).toBe(1);
    expect(completions).toEqual([
      { status: 201, responseText: JSON.stringify({ id: "med-1" }) },
    ]);
  });

  it("bricht ohne Rueckmeldung ab und wiederholt nichts", () => {
    const xhr = new FakeXhr();
    const transport = createXhrUploadTransport({
      xhrFactory: () => xhr as unknown as UploadXhrLike,
    });
    let completed = 0;
    let failed = 0;

    const handle = transport.upload(mediaFile("spot.mp4", 42), {
      onComplete: () => {
        completed += 1;
      },
      onError: () => {
        failed += 1;
      },
    });
    handle.abort();

    expect(xhr.aborted).toBe(true);
    expect(completed).toBe(0);
    expect(failed).toBe(0);
  });
});
