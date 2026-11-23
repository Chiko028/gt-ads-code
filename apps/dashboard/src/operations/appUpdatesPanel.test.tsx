import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { AppUpdatesPanel } from "./AppUpdatesPanel";
import { messageFor, parseOverview } from "./appUpdatesApi";

const RELEASE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE_ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function overview(rollout: string, channel: string) {
  return {
    releases: [
      {
        id: RELEASE_ID,
        version_code: 3,
        version_name: "0.3.0",
        notes: "Abspielnachweis",
        sha256: "a".repeat(64),
        size_bytes: 6_100_000,
        rollout,
        created_at: "2026-11-23T08:00:00.000Z",
        created_by: "admin",
        rollout_changed_at: null,
        downloaded: 0,
        installed: 1,
        failed: 0,
      },
    ],
    devices: [
      {
        device_id: DEVICE_ID,
        label: "S22 Test",
        state: "active",
        taxi_id: "TC-Probe1",
        taxi_name: "Probe",
        update_channel: channel,
        app_version: "0.2.0",
        os_version: "14",
        last_report: {
          release_id: RELEASE_ID,
          version_code: 3,
          version_name: "0.3.0",
          status: "downloaded",
          detail: null,
          reported_at: "2026-11-23T08:05:00.000Z",
        },
      },
    ],
  };
}

function fakeServer() {
  const calls: Call[] = [];
  let state = { rollout: "none", channel: "stable" };
  let uploadStatus = 201;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, headers, body });
    if (method === "GET" && url === "/v1/admin/app-releases") {
      return new Response(JSON.stringify(overview(state.rollout, state.channel)), { status: 200 });
    }
    if (method === "POST" && url.startsWith("/v1/admin/app-releases?")) {
      return new Response(uploadStatus === 201 ? "{}" : JSON.stringify({ error: { code: "invalid_request" } }), { status: uploadStatus });
    }
    if (method === "PATCH" && url === "/v1/admin/app-releases/" + RELEASE_ID) {
      state = { ...state, rollout: (body as { rollout: string }).rollout };
      return new Response("{}", { status: 200 });
    }
    if (method === "PATCH" && url === "/v1/admin/devices/" + DEVICE_ID + "/update-channel") {
      state = { ...state, channel: (body as { update_channel: string }).update_channel };
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  };
  return {
    calls,
    fetchImpl,
    failUploadWith(status: number) {
      uploadStatus = status;
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("App-Updates im Dashboard", () => {
  it("zeigt Versionen und Tablets und gibt erst für Pilot, dann für alle frei", async () => {
    const server = fakeServer();
    const user = userEvent.setup();
    render(<AppUpdatesPanel fetchImpl={server.fetchImpl} />);

    const versions = await screen.findByRole("table", { name: "App-Versionen" });
    expect(within(versions).getByText(/0\.3\.0 \(Nr\. 3\)/)).toBeTruthy();
    expect(within(versions).getByText("Nicht verteilt")).toBeTruthy();
    const tablets = screen.getByRole("table", { name: "App-Version je Tablet" });
    expect(within(tablets).getByText("Probe (TC-Probe1)")).toBeTruthy();
    expect(within(tablets).getByText("0.2.0")).toBeTruthy();
    expect(within(tablets).getByText(/Geladen \(0\.3\.0\)/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Für Pilot freigeben: Version 0.3.0" }));
    await screen.findByText("Nur Pilot-Tablets");
    const patch = server.calls.find((call) => call.method === "PATCH")!;
    expect(patch.body).toEqual({ rollout: "pilot" });
    expect(patch.headers["Content-Type"]).toBe("application/json");

    await user.click(screen.getByRole("button", { name: "Für alle freigeben: Version 0.3.0" }));
    await screen.findByText("Alle Tablets");
    expect(screen.getByRole("button", { name: "Zurückziehen: Version 0.3.0" })).toBeTruthy();
  });

  it("markiert ein Tablet als Pilot-Tablet", async () => {
    const server = fakeServer();
    const user = userEvent.setup();
    render(<AppUpdatesPanel fetchImpl={server.fetchImpl} />);

    const checkbox = (await screen.findByRole("checkbox", { name: "Pilot-Tablet: S22 Test" })) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: "Pilot-Tablet: S22 Test" }) as HTMLInputElement).checked).toBe(true),
    );
    expect(server.calls.find((call) => call.url.endsWith("/update-channel"))?.body).toEqual({ update_channel: "pilot" });
    expect(screen.getByRole("status").textContent).toBe("S22 Test ist jetzt Pilot-Tablet.");
  });

  it("lädt eine APK mit Versionsangaben als Binärdaten hoch und erklärt Ablehnungen", async () => {
    const server = fakeServer();
    const user = userEvent.setup();
    render(<AppUpdatesPanel fetchImpl={server.fetchImpl} />);
    await screen.findByRole("table", { name: "App-Versionen" });

    const form = screen.getByRole("form", { name: "Neue App-Version hochladen" });
    await user.click(within(form).getByRole("button", { name: "Hochladen" }));
    expect(screen.getByRole("alert").textContent).toBe("Bitte eine APK-Datei auswählen.");

    const apk = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], "gtads-0.4.0.apk", {
      type: "application/vnd.android.package-archive",
    });
    await user.upload(within(form).getByLabelText("APK-Datei"), apk);
    await user.type(within(form).getByLabelText("Versionsnummer"), "4");
    await user.type(within(form).getByLabelText("Versionsname"), "0.4.0");
    await user.type(within(form).getByLabelText("Notiz (optional)"), "Logo");
    await user.click(within(form).getByRole("button", { name: "Hochladen" }));

    await screen.findByText("Version 0.4.0 hochgeladen. Sie ist noch nicht verteilt.");
    const upload = server.calls.find((call) => call.method === "POST")!;
    expect(upload.url).toBe(
      "/v1/admin/app-releases?version_code=4&version_name=0.4.0&sha256=e8b35476d2bd55232509d060f0e3b56737376d1848289eea711e974396ef2311&notes=Logo",
    );
    expect(upload.headers["Content-Type"]).toBe("application/octet-stream");
    expect(upload.body).toBe(apk);
    expect((within(form).getByLabelText("Versionsnummer") as HTMLInputElement).value).toBe("");

    server.failUploadWith(409);
    await user.upload(within(form).getByLabelText("APK-Datei"), apk);
    await user.type(within(form).getByLabelText("Versionsnummer"), "3");
    await user.type(within(form).getByLabelText("Versionsname"), "0.3.0");
    await user.click(within(form).getByRole("button", { name: "Hochladen" }));
    await screen.findByText(/Diese Version ist schon vorhanden/);
  });

  it("prüft die Serverantwort und übersetzt Fehler verständlich", () => {
    expect(() => parseOverview({ releases: "x", devices: [] })).toThrow();
    expect(() => parseOverview(overview("vielleicht", "stable"))).toThrow();
    expect(parseOverview(overview("all", "pilot")).devices[0]?.updateChannel).toBe("pilot");
    expect(messageFor(403, "change")).toMatch(/nur ein Admin/);
    expect(messageFor(413, "upload")).toMatch(/200 MB/);
  });

  it("zeigt einen Ladefehler an", async () => {
    render(
      <AppUpdatesPanel
        fetchImpl={async () => new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 })}
      />,
    );
    await screen.findByText("Keine Berechtigung. App-Updates darf nur ein Admin verwalten.");
  });
});
