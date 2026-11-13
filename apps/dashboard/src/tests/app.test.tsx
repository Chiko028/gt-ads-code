import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Dashboard-Einstieg", () => {
  it("rendert die AdminShell und zeigt ohne Sitzung keine Geräte", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "GT-Ads Verwaltung" }),
    ).toBeTruthy();
    await screen.findByRole("heading", { name: "Anmeldung" });
    expect(screen.queryByRole("heading", { name: "Geräte" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
