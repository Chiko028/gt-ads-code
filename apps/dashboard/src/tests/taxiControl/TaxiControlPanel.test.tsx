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

import { TaxiControlPanel } from "../../components/taxiControl/TaxiControlPanel";
import {
  TaxiControlPortError,
  type AppliedRevision,
  type SetDesiredPauseInput,
  type SetDesiredPauseResult,
  type TaxiControlClient,
  type TaxiControlConfig,
  type TaxiControlEntry,
  type TaxiControlSnapshot,
  type UpdateTaxiConfigInput,
  type UpdateTaxiConfigResult,
} from "../../components/taxiControl/taxiControlTypes";

afterEach(() => {
  cleanup();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

interface EntryOptions {
  revision?: number;
  desiredPaused?: boolean;
  commandId?: string | null;
  applied?: AppliedRevision[];
  undeliverable?: string[];
  tabletBConnection?: "online" | "offline";
  configRevision?: number;
  config?: Partial<TaxiControlConfig>;
}

function makeEntry(options: EntryOptions = {}): TaxiControlEntry {
  const config: TaxiControlConfig = {
    taxi_id: "taxi-1",
    revision: options.configRevision ?? 0,
    gps_mode: "aus",
    pause_max_duration_s: null,
    pause_end_on_vehicle_off: null,
    display_run_on_s: null,
    policy_complete: false,
    ...options.config,
  };
  return {
    taxi: {
      taxi_id: "taxi-1",
      taxi_name: "Taxi 1",
      tablets: [
        { tablet_id: "tab-a", label: "Tablet A", connection: "online" },
        {
          tablet_id: "tab-b",
          label: "Tablet B",
          connection: options.tabletBConnection ?? "online",
        },
      ],
    },
    pause: {
      desired_paused: options.desiredPaused ?? false,
      revision: options.revision ?? 0,
      command_id: options.commandId ?? null,
      applied_revisions: options.applied ?? [],
      undeliverable_tablet_ids: options.undeliverable ?? [],
    },
    config,
  };
}

function makeSnapshot(options: EntryOptions = {}): TaxiControlSnapshot {
  return { taxis: [makeEntry(options)] };
}

interface Hooks {
  load?: (call: number) => Promise<TaxiControlSnapshot>;
  setDesiredPause?: (
    input: SetDesiredPauseInput,
  ) => Promise<SetDesiredPauseResult>;
  updateTaxiConfig?: (
    input: UpdateTaxiConfigInput,
  ) => Promise<UpdateTaxiConfigResult>;
}

interface TestClient {
  client: TaxiControlClient;
  setCalls: SetDesiredPauseInput[];
  updateCalls: UpdateTaxiConfigInput[];
  readonly loadCalls: number;
}

function createClient(hooks: Hooks = {}): TestClient {
  const setCalls: SetDesiredPauseInput[] = [];
  const updateCalls: UpdateTaxiConfigInput[] = [];
  let loadCalls = 0;
  const client: TaxiControlClient = {
    async load() {
      loadCalls += 1;
      return hooks.load ? hooks.load(loadCalls) : makeSnapshot();
    },
    async setDesiredPause(input) {
      setCalls.push(input);
      if (hooks.setDesiredPause) {
        return hooks.setDesiredPause(input);
      }
      return {
        taxi_id: input.taxi_id,
        command_id: input.command_id,
        revision: input.expected_revision + 1,
        desired_paused: input.desired_paused,
      };
    },
    async updateTaxiConfig(input) {
      updateCalls.push(input);
      if (hooks.updateTaxiConfig) {
        return hooks.updateTaxiConfig(input);
      }
      return {
        ...input.config,
        taxi_id: input.taxi_id,
        revision: input.expected_revision + 1,
        policy_complete: true,
        change_id: input.change_id,
      };
    },
  };
  return {
    client,
    setCalls,
    updateCalls,
    get loadCalls() {
      return loadCalls;
    },
  };
}

function renderPanel(client: TaxiControlClient) {
  const commandIds = ["cmd-1", "cmd-2", "cmd-3", "cmd-4", "cmd-5"];
  const changeIds = ["change-1", "change-2", "change-3"];
  return render(
    <TaxiControlPanel
      client={client}
      createCommandId={() => commandIds.shift() ?? "cmd-fallback"}
      createChangeId={() => changeIds.shift() ?? "change-fallback"}
    />,
  );
}

async function selectTablet(
  user: ReturnType<typeof userEvent.setup>,
  label = "Tablet A",
) {
  await screen.findByText("Tablet auswählen:");
  await user.click(
    screen.getByRole("button", { name: `Taxi 1: ${label} auswählen` }),
  );
}

describe("TaxiControlPanel", () => {
  it("benennt bei der Tablet-Auswahl Taxi und beide Tablets und sendet genau einen taxiweiten Sollzustandsauftrag", async () => {
    const user = userEvent.setup();
    const { client, setCalls } = createClient();
    renderPanel(client);

    await selectTablet(user);

    expect(screen.getByText("Ausgewähltes Taxi: Taxi 1")).toBeTruthy();
    const pauseRegion = screen.getByRole("region", {
      name: "Pausensteuerung",
    });
    expect(
      within(pauseRegion).getByText(
        /Die Auswahl von Tablet A betrifft beide Tablets des Taxis Taxi 1: Tablet A, Tablet B\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Betroffene Tablet-IDs: tab-a, tab-b"),
    ).toBeTruthy();

    await user.click(
      within(pauseRegion).getByRole("button", { name: "Pause" }),
    );

    await waitFor(() => {
      expect(setCalls).toHaveLength(1);
    });
    expect(setCalls[0]).toEqual({
      taxi_id: "taxi-1",
      command_id: "cmd-1",
      expected_revision: 0,
      desired_paused: true,
    });
    expect(setCalls).toHaveLength(1);
  });

  it("verhindert Doppelklicks während einer laufenden Anfrage", async () => {
    const user = userEvent.setup();
    const pending = deferred<SetDesiredPauseResult>();
    const { client, setCalls } = createClient({
      setDesiredPause: () => pending.promise,
    });
    renderPanel(client);
    await selectTablet(user);

    const pauseButton = screen.getByRole("button", { name: "Pause" });
    fireEvent.click(pauseButton);
    fireEvent.click(pauseButton);

    expect(setCalls).toHaveLength(1);
    expect((pauseButton as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      pending.resolve({
        taxi_id: "taxi-1",
        command_id: "cmd-1",
        revision: 1,
        desired_paused: true,
      });
    });

    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(setCalls).toHaveLength(1);
  });

  it("verwendet nach unklarem Ausgang bei Wiederholen dieselbe command_id und denselben Inhalt, aber für eine neue Absicht eine neue ID", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { client, setCalls } = createClient({
      setDesiredPause: async (input) => {
        attempt += 1;
        if (attempt === 1) {
          throw new TaxiControlPortError("unclear");
        }
        return {
          taxi_id: input.taxi_id,
          command_id: input.command_id,
          revision: input.expected_revision + 1,
          desired_paused: input.desired_paused,
        };
      },
    });
    renderPanel(client);
    await selectTablet(user);

    await user.click(screen.getByRole("button", { name: "Pause" }));
    const retryButton = await screen.findByRole("button", {
      name: "Wiederholen",
    });
    await user.click(retryButton);

    await waitFor(() => {
      expect(setCalls).toHaveLength(2);
    });
    expect(setCalls[1]).toEqual(setCalls[0]);
    expect(setCalls[1]?.command_id).toBe("cmd-1");

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Wiederholen" }),
      ).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() => {
      expect(setCalls).toHaveLength(3);
    });
    expect(setCalls[2]?.command_id).toBe("cmd-2");
    expect(setCalls[2]?.command_id).not.toBe(setCalls[0]?.command_id);
    expect(setCalls[2]?.desired_paused).toBe(false);
  });

  it("zeigt eine Bestätigung je Tablet und den Taxi-Gesamtstatus erst nach beiden Bestätigungen als ausgeführt", async () => {
    const user = userEvent.setup();
    const { client } = createClient({
      load: async (call) =>
        call === 1
          ? makeSnapshot({
              revision: 1,
              desiredPaused: true,
              commandId: "cmd-x",
              applied: [{ tablet_id: "tab-a", revision: 1 }],
            })
          : makeSnapshot({
              revision: 1,
              desiredPaused: true,
              commandId: "cmd-x",
              applied: [
                { tablet_id: "tab-a", revision: 1 },
                { tablet_id: "tab-b", revision: 1 },
              ],
            }),
    });
    renderPanel(client);
    await selectTablet(user);

    expect(screen.getByText("Tablet A: ausgeführt")).toBeTruthy();
    expect(screen.getByText("Tablet B: ausstehend")).toBeTruthy();
    expect(screen.getByText("Taxi-Gesamtstatus: ausstehend")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Status aktualisieren" }),
    );

    await screen.findByText("Tablet B: ausgeführt");
    expect(screen.getByText("Taxi-Gesamtstatus: ausgeführt")).toBeTruthy();
  });

  it("stellt Offline oder fehlende Bestätigung als ausstehend dar und 'nicht zustellbar' nur bei explizitem Portfehler", async () => {
    const user = userEvent.setup();
    const { client } = createClient({
      load: async (call) =>
        call === 1
          ? makeSnapshot({
              revision: 2,
              desiredPaused: true,
              commandId: "cmd-x",
              applied: [{ tablet_id: "tab-a", revision: 2 }],
              tabletBConnection: "offline",
            })
          : makeSnapshot({
              revision: 2,
              desiredPaused: true,
              commandId: "cmd-x",
              applied: [{ tablet_id: "tab-a", revision: 2 }],
              tabletBConnection: "offline",
              undeliverable: ["tab-b"],
            }),
    });
    renderPanel(client);
    await selectTablet(user);

    expect(screen.getByText("Tablet B: ausstehend (offline)")).toBeTruthy();
    expect(screen.getByText("Taxi-Gesamtstatus: ausstehend")).toBeTruthy();
    expect(screen.queryByText("Tablet B: ausgeführt")).toBeNull();
    expect(screen.queryByText("Tablet B: nicht zustellbar")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Status aktualisieren" }),
    );

    await screen.findByText("Tablet B: nicht zustellbar");
    expect(screen.getByText("Taxi-Gesamtstatus: ausstehend")).toBeTruthy();
    expect(screen.queryByText("Taxi-Gesamtstatus: ausgeführt")).toBeNull();
  });

  it("lässt eine ältere verspätete Antwort die neuere Revision nicht zurücksetzen", async () => {
    const user = userEvent.setup();
    const lateLoad = deferred<TaxiControlSnapshot>();
    const { client, setCalls } = createClient({
      load: async (call) =>
        call === 1
          ? makeSnapshot({
              revision: 1,
              desiredPaused: true,
              commandId: "cmd-old",
              applied: [
                { tablet_id: "tab-a", revision: 1 },
                { tablet_id: "tab-b", revision: 1 },
              ],
            })
          : lateLoad.promise,
      setDesiredPause: async (input) => ({
        taxi_id: input.taxi_id,
        command_id: input.command_id,
        revision: 2,
        desired_paused: false,
      }),
    });
    renderPanel(client);
    await selectTablet(user);

    expect(screen.getByText("Taxi-Gesamtstatus: ausgeführt")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Fortsetzen" }));
    await waitFor(() => {
      expect(setCalls).toHaveLength(1);
    });
    await screen.findByText(/Auftrag gesendet/);

    await act(async () => {
      lateLoad.resolve(
        makeSnapshot({
          revision: 1,
          desiredPaused: true,
          commandId: "cmd-old",
          applied: [
            { tablet_id: "tab-a", revision: 1 },
            { tablet_id: "tab-b", revision: 1 },
          ],
        }),
      );
    });

    await waitFor(() => {
      expect(
        screen.getByText("Sollzustand: Fortsetzen (Revision 2)"),
      ).toBeTruthy();
    });
    expect(screen.getByText("Taxi-Gesamtstatus: ausstehend")).toBeTruthy();
    expect(screen.queryByText("Taxi-Gesamtstatus: ausgeführt")).toBeNull();
  });

  it("lädt bei einem Pausen-Revisionskonflikt aktuelle Daten nach und sendet nicht automatisch erneut", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const testClient = createClient({
      load: async (call) =>
        call === 1
          ? makeSnapshot({
              revision: 3,
              desiredPaused: true,
              commandId: "cmd-3",
              applied: [
                { tablet_id: "tab-a", revision: 3 },
                { tablet_id: "tab-b", revision: 3 },
              ],
            })
          : makeSnapshot({
              revision: 4,
              desiredPaused: false,
              commandId: "cmd-4",
              applied: [
                { tablet_id: "tab-a", revision: 4 },
                { tablet_id: "tab-b", revision: 4 },
              ],
            }),
      setDesiredPause: async (input) => {
        attempt += 1;
        if (attempt === 1) {
          throw new TaxiControlPortError("revision_conflict");
        }
        return {
          taxi_id: input.taxi_id,
          command_id: input.command_id,
          revision: input.expected_revision + 1,
          desired_paused: input.desired_paused,
        };
      },
    });
    const { client, setCalls } = testClient;
    renderPanel(client);
    await selectTablet(user);

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByText(/Revisionskonflikt/);

    await waitFor(() => {
      expect(testClient.loadCalls).toBe(2);
    });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.expected_revision).toBe(3);
    expect(
      screen.getByText("Sollzustand: Fortsetzen (Revision 4)"),
    ).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setCalls).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(setCalls).toHaveLength(2);
    });
    expect(setCalls[1]?.expected_revision).toBe(4);
    expect(setCalls[1]?.command_id).toBe("cmd-2");
  });

  it("zeigt GPS initial aus und nicht aktivierbar sowie ungesetzte E36/E40-Parameter als nicht konfiguriert", async () => {
    const user = userEvent.setup();
    const { client } = createClient();
    renderPanel(client);
    await selectTablet(user);

    const gps = screen.getByRole("checkbox", {
      name: "GPS aktivieren",
    }) as HTMLInputElement;
    expect(gps.checked).toBe(false);
    expect(gps.disabled).toBe(true);
    await user.click(gps);
    expect(gps.checked).toBe(false);

    expect(
      (
        screen.getByLabelText(
          "Pausenmaximaldauer (Sekunden)",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      (
        screen.getByLabelText(
          "Pause endet bei Fahrzeug-aus",
        ) as HTMLSelectElement
      ).value,
    ).toBe("unset");
    expect(
      (
        screen.getByLabelText(
          "Nachlauf Display (Sekunden)",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(screen.getAllByText("nicht konfiguriert").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(screen.getByText(/Nutzungssperre/)).toBeTruthy();
    expect(
      screen.getByText("Tablet-Policy nicht vollständig konfiguriert."),
    ).toBeTruthy();
  });

  it("lädt bei Revisionskonflikt aktuelle Daten nach und verlangt eine erneute bewusste Änderung", async () => {
    const user = userEvent.setup();
    let updateAttempt = 0;
    const { client, updateCalls } = createClient({
      load: async (call) =>
        call === 1
          ? makeSnapshot({
              configRevision: 5,
              config: {
                pause_max_duration_s: 60,
                pause_end_on_vehicle_off: true,
                display_run_on_s: 120,
                policy_complete: true,
              },
            })
          : makeSnapshot({
              configRevision: 6,
              config: {
                pause_max_duration_s: 90,
                pause_end_on_vehicle_off: false,
                display_run_on_s: 180,
                policy_complete: true,
              },
            }),
      updateTaxiConfig: async (input) => {
        updateAttempt += 1;
        if (updateAttempt === 1) {
          throw new TaxiControlPortError("revision_conflict");
        }
        return {
          ...input.config,
          taxi_id: input.taxi_id,
          revision: input.expected_revision + 1,
          policy_complete: true,
          change_id: input.change_id,
        };
      },
    });
    renderPanel(client);
    await selectTablet(user);

    const pauseMax = screen.getByLabelText(
      "Pausenmaximaldauer (Sekunden)",
    ) as HTMLInputElement;
    await user.clear(pauseMax);
    await user.type(pauseMax, "120");

    const save = screen.getByRole("button", {
      name: "Konfiguration speichern",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);

    await screen.findByText(/Revisionskonflikt/);
    await waitFor(() => {
      expect(updateCalls).toHaveLength(1);
      expect(pauseMax.value).toBe("90");
    });
    expect(save.disabled).toBe(true);
    expect(updateCalls).toHaveLength(1);

    await user.clear(pauseMax);
    await user.type(pauseMax, "150");
    expect(save.disabled).toBe(false);
    await user.click(save);

    await screen.findByText(/Konfiguration gespeichert/);
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[1]?.expected_revision).toBe(6);
    expect(updateCalls[1]?.config.pause_max_duration_s).toBe(150);
  });

  it("zeigt bei fehlender Berechtigung eine Meldung ohne Erfolgssimulation", async () => {
    const user = userEvent.setup();
    const { client, updateCalls } = createClient({
      updateTaxiConfig: async () => {
        throw new TaxiControlPortError("forbidden");
      },
    });
    renderPanel(client);
    await selectTablet(user);

    const pauseMax = screen.getByLabelText(
      "Pausenmaximaldauer (Sekunden)",
    ) as HTMLInputElement;
    await user.type(pauseMax, "30");
    await user.click(
      screen.getByRole("button", { name: "Konfiguration speichern" }),
    );

    await screen.findByText("Keine Berechtigung zum Ändern der Konfiguration.");
    expect(screen.queryByText(/Konfiguration gespeichert/)).toBeNull();
    expect(updateCalls).toHaveLength(1);
  });

  it("zeigt bei Schreibfehlern eine Meldung ohne Erfolgssimulation", async () => {
    const user = userEvent.setup();
    const { client, updateCalls } = createClient({
      updateTaxiConfig: async () => {
        throw new TaxiControlPortError("server");
      },
    });
    renderPanel(client);
    await selectTablet(user);

    const runOn = screen.getByLabelText(
      "Nachlauf Display (Sekunden)",
    ) as HTMLInputElement;
    await user.type(runOn, "15");
    await user.click(
      screen.getByRole("button", { name: "Konfiguration speichern" }),
    );

    await screen.findByText("Die Konfiguration konnte nicht gespeichert werden.");
    expect(screen.queryByText(/Konfiguration gespeichert/)).toBeNull();
    expect(updateCalls).toHaveLength(1);
  });

  it("simuliert bei einem abgelehnten Pausenauftrag keinen Erfolg", async () => {
    const user = userEvent.setup();
    const { client, setCalls } = createClient({
      setDesiredPause: async () => {
        throw new TaxiControlPortError("forbidden");
      },
    });
    renderPanel(client);
    await selectTablet(user);

    await user.click(screen.getByRole("button", { name: "Pause" }));

    await screen.findByText("Keine Berechtigung für diese Aktion.");
    expect(screen.getByText("Taxi-Gesamtstatus: kein Auftrag")).toBeTruthy();
    expect(screen.queryByText("Taxi-Gesamtstatus: ausgeführt")).toBeNull();
    expect(setCalls).toHaveLength(1);
  });
});
