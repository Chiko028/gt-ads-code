import { describe, it, expect } from "vitest";
import pg from "pg";
import Fastify from "fastify";
import { add } from "./add";
describe("Werkzeugkette offline", () => {
  it("rechnet", () => expect(add(2, 3)).toBe(5));
  it("spricht mit PostgreSQL ueber den Unix-Socket", async () => {
    const c = new pg.Client({ connectionString: process.env.GT_ADS_DB_URL });
    await c.connect();
    const r = await c.query("select 41 + 1 as x");
    await c.end();
    expect(r.rows[0].x).toBe(42);
  });
  it("Fastify antwortet (inject, ohne Port)", async () => {
    const app = Fastify();
    app.get("/ping", async () => ({ ok: true }));
    const res = await app.inject({ url: "/ping" });
    expect(res.json()).toEqual({ ok: true });
  });
});
