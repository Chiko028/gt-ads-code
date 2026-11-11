// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { it, expect } from "vitest";
import { App } from "./App";
it("rendert das Dashboard-Geruest (React + jsdom)", () => { render(<App />); expect(screen.getByText("GT-Ads")).toBeTruthy(); });
