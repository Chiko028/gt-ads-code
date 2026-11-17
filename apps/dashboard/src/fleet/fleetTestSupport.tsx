import { render } from "@testing-library/react";

import type { AdminSessionRole, FetchLike } from "../admin/adminApi";
import { AdminShell } from "../admin/AdminShell";
import type {
  FleetGroup,
  FleetInventoryItem,
  FleetTablet,
  FleetTaxi,
  FleetTransport,
  FleetTransportRequest,
} from "./fleetApi";
import { FleetPage } from "./FleetPage";

export interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: string | null;
}

export type Handler = (call: Call) => Response | Promise<Response>;

export interface RecordedTransport {
  readonly transport: FleetTransport;
  readonly calls: Call[];
  count(method: string, path: string): number;
  bodyOf(method: string, path: string): unknown;
}

/** Transport ohne jede Netzverbindung; zeichnet alle Anfragen auf. */
export function createTransport(handler: Handler): RecordedTransport {
  const calls: Call[] = [];
  const transport: FleetTransport = async (request: FleetTransportRequest) => {
    const call: Call = {
      path: request.path,
      method: request.method,
      body:
        request.body === undefined ? null : JSON.stringify(request.body),
    };
    calls.push(call);
    return handler(call);
  };
  return {
    transport,
    calls,
    count(method: string, path: string) {
      return calls.filter(
        (call) => call.method === method && call.path === path,
      ).length;
    },
    bodyOf(method: string, path: string) {
      const matching = calls.filter(
        (entry) => entry.method === method && entry.path === path,
      );
      const call = matching[matching.length - 1];
      if (call === undefined || call.body === null) {
        return null;
      }
      return JSON.parse(call.body) as unknown;
    },
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function empty(status = 204): Response {
  return new Response(null, { status });
}

/** Nur die AdminShell-Anmeldepruefung; Fleet laeuft ueber den Transport. */
export function shellFetch(): FetchLike {
  return async (input, init) => {
    const path = String(input).replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    if (path === "/admin/registration-codes" && method === "GET") {
      return json(200, { items: [] });
    }
    if (path === "/admin/logout" && method === "POST") {
      return empty();
    }
    throw new Error("Unerwarteter Shell-Aufruf: " + method + " " + path);
  };
}

export function renderFleet(
  transport: FleetTransport,
  role?: AdminSessionRole,
) {
  return render(
    <AdminShell fetchImpl={shellFetch()} role={role}>
      <FleetPage transport={transport} />
    </AdminShell>,
  );
}

export function wireTaxi(taxi: FleetTaxi): unknown {
  return {
    id: taxi.id,
    display_name: taxi.displayName,
    active: taxi.active,
    revision: taxi.revision,
    tablet_ids: [...taxi.tabletIds],
    group_ids: [...taxi.groupIds],
  };
}

export function wireGroup(group: FleetGroup): unknown {
  return {
    id: group.id,
    name: group.name,
    revision: group.revision,
  };
}

export function wireTablet(tablet: FleetTablet): unknown {
  return {
    id: tablet.id,
    label: tablet.label,
    available: tablet.available,
    active: tablet.active,
    revision: tablet.revision,
  };
}

export function wireInventory(item: FleetInventoryItem): unknown {
  return {
    id: item.deviceId,
    serial_number: item.serialNumber,
    device_type: item.deviceType,
    replacement_note: item.replacementNote,
    admin_active: item.adminActive,
    revision: item.revision,
  };
}

export function taxi(
  overrides: Partial<FleetTaxi> & { id: string },
): FleetTaxi {
  const { id, ...rest } = overrides;
  return {
    id,
    displayName: "Taxi " + id,
    active: false,
    revision: 1,
    tabletIds: [null, null],
    groupIds: [],
    ...rest,
  };
}

export function group(
  overrides: Partial<FleetGroup> & { id: string },
): FleetGroup {
  const { id, ...rest } = overrides;
  return {
    id,
    name: "Gruppe " + id,
    revision: 1,
    ...rest,
  };
}

export function tablet(
  overrides: Partial<FleetTablet> & { id: string },
): FleetTablet {
  const { id, ...rest } = overrides;
  return {
    id,
    label: "Tablet " + id,
    available: true,
    active: true,
    revision: 1,
    ...rest,
  };
}

export function inventoryItem(
  overrides: Partial<FleetInventoryItem> & { deviceId: string },
): FleetInventoryItem {
  const { deviceId, ...rest } = overrides;
  return {
    deviceId,
    serialNumber: null,
    deviceType: null,
    replacementNote: null,
    adminActive: true,
    revision: 1,
    ...rest,
  };
}

export const PATHS = {
  taxis: "/v1/admin/taxis",
  taxi: (id: string) => "/v1/admin/taxis/" + id,
  taxiTablets: (id: string) => "/v1/admin/taxis/" + id + "/tablets",
  taxiActivation: (id: string) => "/v1/admin/taxis/" + id + "/activation",
  groups: "/v1/admin/taxi-groups",
  group: (id: string) => "/v1/admin/taxi-groups/" + id,
  tablets: "/v1/admin/tablets",
  tabletActivation: (id: string) =>
    "/v1/admin/tablets/" + id + "/activation",
  inventory: "/v1/admin/inventory",
  inventoryItem: (id: string) => "/v1/admin/inventory/" + id,
} as const;

