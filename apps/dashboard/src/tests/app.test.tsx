import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../App";

afterEach(cleanup);

describe("U0 Dashboard-Geruest", () => {
  it("zeigt den leeren Zustand ohne Demo-Daten", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "GT-Ads Verwaltung" })).toBeTruthy();
    expect(screen.getByText("Noch keine Geräte registriert.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
