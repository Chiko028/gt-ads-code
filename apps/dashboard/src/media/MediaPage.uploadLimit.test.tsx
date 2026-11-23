import {
  act,
  cleanup,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";
import type { FetchLike } from "../admin/adminApi";
import type {
  UploadAbortHandle,
  UploadTransport,
  UploadTransportCallbacks,
} from "./uploadTransport";
import { MEDIA_UPLOAD_PROFILE_MAX_BYTES } from "./MediaPage";

/**
 * CX-158 / R-206: Die Medienseite muss dieselbe Profilgrenze zeigen und
 * anwenden wie die API aus CX-155/CX-157. Die Dateien tragen nur eine
 * kontrollierte size-Eigenschaft; es wird kein grosser Puffer allokiert.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Minimale Admin-API: angemeldet (Sitzungscheck), leere Medienliste. */
function createFetch(): FetchLike {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/admin/registration-codes")) {
      return json(200, { items: [] });
    }
    if (method === "GET" && url.endsWith("/admin/media")) {
      return json(200, { items: [] });
    }
    return json(404, { error: { code: "not_found" } });
  };
}

class FakeTransport implements UploadTransport {
  readonly calls: Array<{
    readonly file: File;
    readonly callbacks: UploadTransportCallbacks;
  }> = [];

  upload(file: File, callbacks: UploadTransportCallbacks): UploadAbortHandle {
    this.calls.push({ file, callbacks });
    return { abort: () => undefined };
  }

  last() {
    return this.calls[this.calls.length - 1];
  }
}

/** Datei mit exakt gewuenschter Groesse, ohne die Bytes zu allokieren. */
function sizedFile(name: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

async function openMediaPage(transport: UploadTransport) {
  window.history.replaceState(null, "", "#/medien");
  render(<App fetchImpl={createFetch()} uploadTransport={transport} />);
  await screen.findByRole("heading", { name: "Medien" });
  const region = screen.getByRole("region", { name: "Medien" });
  return region;
}

async function chooseFile(region: HTMLElement, file: File): Promise<void> {
  const user = userEvent.setup();
  await user.upload(within(region).getByLabelText("Datei"), file);
}

async function clickUpload(region: HTMLElement): Promise<void> {
  const user = userEvent.setup();
  await user.click(within(region).getByRole("button", { name: "Hochladen" }));
}

describe("CX-158 Upload-Profilgrenze der Medienseite", () => {
  it("laesst eine Datei exakt an der CX-155-Profilgrenze zu und sendet genau einen Upload", async () => {
    const transport = new FakeTransport();
    const region = await openMediaPage(transport);
    const file = sizedFile("grenze.mp4", MEDIA_UPLOAD_PROFILE_MAX_BYTES);

    await chooseFile(region, file);
    await clickUpload(region);

    expect(transport.calls).toHaveLength(1);
    expect(transport.last()?.file).toBe(file);
    expect(within(region).queryByRole("alert")).toBeNull();
  });

  it("weist eine Datei ein Byte oberhalb der Grenze verstaendlich ab und sendet nichts", async () => {
    const transport = new FakeTransport();
    const region = await openMediaPage(transport);

    await chooseFile(region, sizedFile("zu-gross.mp4", MEDIA_UPLOAD_PROFILE_MAX_BYTES + 1));
    await clickUpload(region);

    expect(transport.calls).toHaveLength(0);
    const alert = within(region).getByRole("alert");
    expect(alert.textContent).toContain("zu groß");
    expect(alert.textContent).toContain("1.000.000.000");
    expect(alert.textContent).toContain("nicht gesendet");
    expect(within(region).queryByText(/Upload bestätigt/)).toBeNull();
    // Die Grenze ist keine 20-MB-Anzeige mehr.
    expect(within(region).queryByText(/20\.000\.000/)).toBeNull();
  });

  it("zeigt einen 413 der API verstaendlich, beendet den Uploadzustand und erlaubt erneute Dateiauswahl", async () => {
    const transport = new FakeTransport();
    const region = await openMediaPage(transport);
    const input = within(region).getByLabelText("Datei") as HTMLInputElement;

    await chooseFile(region, sizedFile("spot.mp4", 42));
    await clickUpload(region);
    expect(within(region).getByText("Wird hochgeladen … (Fortschritt unbekannt)")).toBeTruthy();
    expect(input.disabled).toBe(true);

    const callbacks = transport.last()?.callbacks;
    if (callbacks === undefined) {
      throw new Error("Transportaufruf fehlt.");
    }
    await act(async () => {
      callbacks.onComplete?.({
        status: 413,
        responseText: JSON.stringify({ error: { code: "file_too_large" } }),
      });
      await Promise.resolve();
    });

    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toContain("zu groß");
    expect(alert.textContent).toContain("413");
    // Der Uploadzustand ist beendet: kein Fortschritt, keine Pruefung, Eingabe frei.
    expect(within(region).queryByText("Wird geprüft …")).toBeNull();
    expect(within(region).queryByText(/übertragen/)).toBeNull();
    expect(input.disabled).toBe(false);
    const uploadButton = within(region).getByRole("button", { name: "Hochladen" }) as HTMLButtonElement;
    expect(uploadButton.disabled).toBe(false);

    // Eine erneute Dateiauswahl bleibt moeglich und raeumt den Fehler ab.
    await chooseFile(region, sizedFile("erneut.mp4", 8));
    expect(within(region).queryByRole("alert")).toBeNull();
    expect(input.disabled).toBe(false);
  });
});
