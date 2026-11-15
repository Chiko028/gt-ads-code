/**
 * CX-050 / R-405: Der Statistikclient nutzt den gemeinsamen Transport der
 * bestehenden Client-Abstraktion (CX-026) statt einer eigenen
 * Netzwerkimplementierung.
 */
import { describe, expect, it } from "vitest";

import { AdminApiError } from "../admin/adminApi";
import type { FetchLike } from "../admin/adminApi";
import {
  createStatisticsClient,
  STATISTICS_API_PATH,
  type StatisticsRequest,
} from "./statisticsApi";

const REQUEST: StatisticsRequest = {
  from: "2026-11-08T00:00:00.000Z",
  to: "2026-11-15T00:00:00.000Z",
  campaignId: null,
  deviceId: null,
  taxiId: null,
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function captureFetch(
  respond: (call: Call) => Response,
): { readonly fetchImpl: FetchLike; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { fetchImpl, calls };
}

async function caught(promise: Promise<unknown>): Promise<AdminApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdminApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("kein Fehler geworfen");
}

describe("CX-050 Statistikclient", () => {
  it("sendet die Anfrage über den gemeinsamen Transport mit Sitzungsbehandlung", async () => {
    let unauthorizedCalls = 0;
    const { fetchImpl, calls } = captureFetch(() => {
      return new Response(JSON.stringify({ error: { code: "unauthorized" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = createStatisticsClient({
      fetchImpl,
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
    });

    const error = await caught(client.getStatistics(REQUEST));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "/v1" + STATISTICS_API_PATH + "?from=2026-11-08T00%3A00%3A00.000Z&to=2026-11-15T00%3A00%3A00.000Z",
    );
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.credentials).toBe("same-origin");
    expect(unauthorizedCalls).toBe(1);
    expect(error.kind).toBe("unauthorized");
    expect(error.message).toBe(
      "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
    );
  });

  it("übersetzt HTTP-Fehler und ungültige Antworten zentral", async () => {
    const server = captureFetch(
      () => new Response("{}", { status: 500 }),
    );
    const serverError = await caught(
      createStatisticsClient({ fetchImpl: server.fetchImpl }).getStatistics(
        REQUEST,
      ),
    );
    expect(serverError.kind).toBe("server");

    const invalid = captureFetch(
      () => new Response("{}", { status: 422 }),
    );
    const invalidError = await caught(
      createStatisticsClient({ fetchImpl: invalid.fetchImpl }).getStatistics(
        REQUEST,
      ),
    );
    expect(invalidError.kind).toBe("invalid_request");

    const brokenJson = captureFetch(
      () => new Response("kein json", { status: 200 }),
    );
    const responseError = await caught(
      createStatisticsClient({
        fetchImpl: brokenJson.fetchImpl,
      }).getStatistics(REQUEST),
    );
    expect(responseError.kind).toBe("invalid_response");
  });

  it("meldet Netzwerkfehler des Transports als bereinigten Fehler", async () => {
    const fetchImpl: FetchLike = () => {
      return Promise.reject(new TypeError("offline"));
    };
    const error = await caught(
      createStatisticsClient({ fetchImpl }).getStatistics(REQUEST),
    );
    expect(error.kind).toBe("network");
    expect(error.message).toBe(
      "Der Server ist nicht erreichbar. Bitte die Verbindung prüfen.",
    );
  });
});
