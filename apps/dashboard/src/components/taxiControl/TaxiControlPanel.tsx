import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  isTaxiControlPortError,
  TaxiControlPortError,
  type AppliedRevision,
  type SetDesiredPauseResult,
  type TaxiControlClient,
  type TaxiControlConfig,
  type TaxiControlConfigValues,
  type TaxiControlEntry,
  type TaxiControlSnapshot,
  type UpdateTaxiConfigResult,
} from "./taxiControlTypes";

const LOAD_FAILED = "Die Taxidaten konnten nicht geladen werden.";
const UNEXPECTED = "Ein unerwarteter Fehler ist aufgetreten.";
const COMMAND_UNCLEAR =
  "Der Auftrag konnte nicht eindeutig bestätigt werden. Ergebnis unklar; Wiederholen sendet denselben Auftrag erneut.";
const COMMAND_CONFLICT =
  "Revisionskonflikt: Der Auftrag wurde nicht ausgeführt. Aktuelle Daten wurden geladen; bitte prüfen und bewusst erneut ändern.";
const COMMAND_FORBIDDEN = "Keine Berechtigung für diese Aktion.";
const COMMAND_FAILED = "Der Auftrag ist fehlgeschlagen.";
const COMMAND_SENT =
  "Auftrag gesendet. Ausgeführt wird erst nach Bestätigung beider Tablets.";
const CONFIG_CONFLICT =
  "Revisionskonflikt: Die Konfiguration wurde nicht gespeichert. Aktuelle Daten wurden geladen; bitte bewusst erneut ändern.";
const CONFIG_FORBIDDEN = "Keine Berechtigung zum Ändern der Konfiguration.";
const CONFIG_FAILED = "Die Konfiguration konnte nicht gespeichert werden.";

interface CommandAttempt {
  taxi_id: string;
  command_id: string;
  expected_revision: number;
  desired_paused: boolean;
}

interface ActionMessage {
  kind: "error" | "status";
  text: string;
}

function defaultCommandId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeApplied(
  previous: readonly AppliedRevision[],
  next: readonly AppliedRevision[],
): AppliedRevision[] {
  const revisions = new Map<string, number>();
  for (const item of previous) {
    revisions.set(item.tablet_id, item.revision);
  }
  for (const item of next) {
    const existing = revisions.get(item.tablet_id);
    if (existing === undefined || item.revision > existing) {
      revisions.set(item.tablet_id, item.revision);
    }
  }
  return [...revisions.entries()].map(([tablet_id, revision]) => ({
    tablet_id,
    revision,
  }));
}

/**
 * Fuehrt einen geladenen Stand monoton zusammen. Eine verspaetete aeltere
 * Revision darf weder Sollzustand noch angewandte Revisionen zuruecksetzen.
 */
function mergeEntry(
  previous: TaxiControlEntry,
  next: TaxiControlEntry,
): TaxiControlEntry {
  const config =
    next.config.revision >= previous.config.revision
      ? next.config
      : previous.config;
  if (next.pause.revision < previous.pause.revision) {
    return { taxi: previous.taxi, pause: previous.pause, config };
  }
  return {
    taxi: next.taxi,
    pause: {
      ...next.pause,
      applied_revisions: mergeApplied(
        previous.pause.applied_revisions,
        next.pause.applied_revisions,
      ),
      undeliverable_tablet_ids:
        next.pause.revision === previous.pause.revision
          ? uniqueStrings([
              ...previous.pause.undeliverable_tablet_ids,
              ...next.pause.undeliverable_tablet_ids,
            ])
          : [...next.pause.undeliverable_tablet_ids],
    },
    config,
  };
}

function mergeSnapshot(
  previous: TaxiControlEntry[] | null,
  snapshot: TaxiControlSnapshot,
): TaxiControlEntry[] {
  if (previous === null) {
    return [...snapshot.taxis];
  }
  const byTaxi = new Map(previous.map((entry) => [entry.taxi.taxi_id, entry]));
  const merged: TaxiControlEntry[] = [];
  for (const entry of snapshot.taxis) {
    const existing = byTaxi.get(entry.taxi.taxi_id);
    if (existing === undefined) {
      merged.push(entry);
    } else {
      merged.push(mergeEntry(existing, entry));
      byTaxi.delete(entry.taxi.taxi_id);
    }
  }
  // Ein aelterer Stand darf ein bereits bekanntes Taxi nicht ausblenden.
  for (const entry of previous) {
    if (byTaxi.has(entry.taxi.taxi_id)) {
      merged.push(entry);
    }
  }
  return merged;
}

function applyCommandResult(
  entry: TaxiControlEntry,
  result: SetDesiredPauseResult,
): TaxiControlEntry {
  if (result.revision < entry.pause.revision) {
    return entry;
  }
  const sameRevision = result.revision === entry.pause.revision;
  const undeliverable =
    result.undeliverable_tablet_ids === undefined
      ? entry.pause.undeliverable_tablet_ids
      : sameRevision
        ? uniqueStrings([
            ...entry.pause.undeliverable_tablet_ids,
            ...result.undeliverable_tablet_ids,
          ])
        : [...result.undeliverable_tablet_ids];
  return {
    taxi: entry.taxi,
    pause: {
      desired_paused: result.desired_paused,
      revision: result.revision,
      command_id: result.command_id,
      applied_revisions: mergeApplied(
        entry.pause.applied_revisions,
        result.applied_revisions ?? [],
      ),
      undeliverable_tablet_ids: undeliverable,
    },
    config: entry.config,
  };
}

function applyConfigResult(
  entry: TaxiControlEntry,
  result: UpdateTaxiConfigResult,
): TaxiControlEntry {
  if (result.revision < entry.config.revision) {
    return entry;
  }
  return {
    ...entry,
    config: {
      taxi_id: result.taxi_id,
      revision: result.revision,
      gps_mode: result.gps_mode,
      pause_max_duration_s: result.pause_max_duration_s,
      pause_end_on_vehicle_off: result.pause_end_on_vehicle_off,
      display_run_on_s: result.display_run_on_s,
      policy_complete: result.policy_complete,
    },
  };
}

function tabletExecutionStatus(
  entry: TaxiControlEntry,
  tabletId: string,
): string {
  const pause = entry.pause;
  if (pause.revision === 0) {
    return "kein Auftrag";
  }
  const applied = pause.applied_revisions.find(
    (revision) => revision.tablet_id === tabletId,
  );
  if (applied !== undefined && applied.revision >= pause.revision) {
    return "ausgeführt";
  }
  if (pause.undeliverable_tablet_ids.includes(tabletId)) {
    return "nicht zustellbar";
  }
  const tablet = entry.taxi.tablets.find((item) => item.tablet_id === tabletId);
  if (tablet !== undefined && tablet.connection === "offline") {
    return "ausstehend (offline)";
  }
  return "ausstehend";
}

function overallExecutionStatus(entry: TaxiControlEntry): string {
  if (entry.pause.revision === 0) {
    return "kein Auftrag";
  }
  const appliedForAll = entry.taxi.tablets.every(
    (tablet) => tabletExecutionStatus(entry, tablet.tablet_id) === "ausgeführt",
  );
  return appliedForAll ? "ausgeführt" : "ausstehend";
}

function pauseActionMessage(error: unknown): ActionMessage {
  if (!isTaxiControlPortError(error)) {
    return { kind: "error", text: UNEXPECTED };
  }
  switch (error.kind) {
    case "unclear":
    case "network":
      return { kind: "error", text: COMMAND_UNCLEAR };
    case "revision_conflict":
      return { kind: "error", text: COMMAND_CONFLICT };
    case "forbidden":
      return { kind: "error", text: COMMAND_FORBIDDEN };
    case "invalid_request":
      return { kind: "error", text: "Die Anfrage wurde abgelehnt." };
    case "server":
      return { kind: "error", text: COMMAND_FAILED };
  }
}

function configActionMessage(error: unknown): ActionMessage {
  if (!isTaxiControlPortError(error)) {
    return { kind: "error", text: UNEXPECTED };
  }
  switch (error.kind) {
    case "revision_conflict":
      return { kind: "error", text: CONFIG_CONFLICT };
    case "forbidden":
      return { kind: "error", text: CONFIG_FORBIDDEN };
    case "unclear":
    case "network":
      return {
        kind: "error",
        text: "Der Schreibvorgang konnte nicht bestätigt werden. Bitte Status prüfen.",
      };
    case "invalid_request":
      return { kind: "error", text: "Die Konfiguration wurde abgelehnt." };
    case "server":
      return { kind: "error", text: CONFIG_FAILED };
  }
}

function loadMessage(error: unknown): string {
  if (isTaxiControlPortError(error) && error.kind === "forbidden") {
    return "Keine Berechtigung zum Laden der Taxidaten.";
  }
  return LOAD_FAILED;
}

interface Draft {
  pauseMax: string;
  endOnVehicleOff: "unset" | "true" | "false";
  displayRunOn: string;
}

function toDraft(config: TaxiControlConfig): Draft {
  return {
    pauseMax:
      config.pause_max_duration_s === null
        ? ""
        : String(config.pause_max_duration_s),
    endOnVehicleOff:
      config.pause_end_on_vehicle_off === null
        ? "unset"
        : config.pause_end_on_vehicle_off
          ? "true"
          : "false",
    displayRunOn:
      config.display_run_on_s === null ? "" : String(config.display_run_on_s),
  };
}

function parseOptionalInteger(
  raw: string,
  options: { minimum: number },
): number | null | string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return "Bitte eine ganze Zahl in Sekunden eingeben.";
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < options.minimum) {
    return `Bitte eine ganze Zahl ab ${options.minimum} eingeben.`;
  }
  return value;
}

function parseDraft(draft: Draft): TaxiControlConfigValues | string {
  const pauseMax = parseOptionalInteger(draft.pauseMax, { minimum: 1 });
  if (typeof pauseMax === "string") {
    return `Pausenmaximaldauer: ${pauseMax}`;
  }
  const displayRunOn = parseOptionalInteger(draft.displayRunOn, { minimum: 0 });
  if (typeof displayRunOn === "string") {
    return `Nachlauf Display: ${displayRunOn}`;
  }
  return {
    gps_mode: "aus",
    pause_max_duration_s: pauseMax,
    pause_end_on_vehicle_off:
      draft.endOnVehicleOff === "unset"
        ? null
        : draft.endOnVehicleOff === "true",
    display_run_on_s: displayRunOn,
  };
}

interface TaxiConfigFormProps {
  entry: TaxiControlEntry;
  client: TaxiControlClient;
  createChangeId: () => string;
  onReload: () => Promise<boolean>;
  onSaved: (result: UpdateTaxiConfigResult) => void;
}

function TaxiConfigForm({
  entry,
  client,
  createChangeId,
  onReload,
  onSaved,
}: TaxiConfigFormProps) {
  const config = entry.config;
  const [draft, setDraft] = useState<Draft>(() => toDraft(config));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const idPrefix = useId();

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setDraft(toDraft(config));
    setDirty(false);
  }, [config.taxi_id, config.revision]);

  const edit = useCallback((next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
    setMessage(null);
  }, []);

  const submit = useCallback(async () => {
    if (busyRef.current || !dirty) {
      return;
    }
    const parsed = parseDraft(draft);
    if (typeof parsed === "string") {
      setMessage({ kind: "error", text: parsed });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await client.updateTaxiConfig({
        taxi_id: entry.taxi.taxi_id,
        change_id: createChangeId(),
        expected_revision: config.revision,
        config: parsed,
      });
      if (!aliveRef.current) {
        return;
      }
      onSaved(result);
      setDirty(false);
      setMessage({
        kind: "status",
        text: `Konfiguration gespeichert (Revision ${result.revision}).`,
      });
    } catch (error) {
      if (!aliveRef.current) {
        return;
      }
      const actionMessage = configActionMessage(error);
      setMessage(actionMessage);
      if (
        isTaxiControlPortError(error) &&
        error.kind === "revision_conflict"
      ) {
        // Keine automatische Uebernahme und kein erneutes Senden: erst laden,
        // danach verlangt der nicht mehr gesetzte Dirty-Zustand eine neue,
        // bewusste Aenderung.
        setDirty(false);
        await onReload();
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) {
        setBusy(false);
      }
    }
  }, [
    busyRef,
    client,
    config.revision,
    createChangeId,
    dirty,
    draft,
    entry.taxi.taxi_id,
    onReload,
    onSaved,
  ]);

  return (
    <section aria-label="Taxi-Konfiguration">
      <h3>Konfiguration für {entry.taxi.taxi_name}</h3>
      <p>Konfigurationsrevision: {config.revision}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label htmlFor={`${idPrefix}-pause-max`}>
            Pausenmaximaldauer (Sekunden)
          </label>
          <input
            id={`${idPrefix}-pause-max`}
            type="number"
            min={1}
            step={1}
            value={draft.pauseMax}
            disabled={busy}
            onChange={(event) => edit({ pauseMax: event.target.value })}
          />
          {draft.pauseMax === "" ? <span>nicht konfiguriert</span> : null}
        </div>

        <div>
          <label htmlFor={`${idPrefix}-vehicle-off`}>
            Pause endet bei Fahrzeug-aus
          </label>
          <select
            id={`${idPrefix}-vehicle-off`}
            value={draft.endOnVehicleOff}
            disabled={busy}
            onChange={(event) =>
              edit({
                endOnVehicleOff: event.target.value as Draft["endOnVehicleOff"],
              })
            }
          >
            <option value="unset">nicht konfiguriert</option>
            <option value="true">Ja</option>
            <option value="false">Nein</option>
          </select>
        </div>

        <div>
          <label htmlFor={`${idPrefix}-run-on`}>
            Nachlauf Display (Sekunden)
          </label>
          <input
            id={`${idPrefix}-run-on`}
            type="number"
            min={0}
            step={1}
            value={draft.displayRunOn}
            disabled={busy}
            onChange={(event) => edit({ displayRunOn: event.target.value })}
          />
          {draft.displayRunOn === "" ? (
            <span>nicht konfiguriert</span>
          ) : null}
        </div>

        <div>
          <label htmlFor={`${idPrefix}-gps`}>GPS aktivieren</label>
          <input
            id={`${idPrefix}-gps`}
            type="checkbox"
            checked={false}
            disabled
            readOnly
            onChange={() => undefined}
          />
          <p>
            GPS ist ausgeschaltet und kann nicht aktiviert werden. Es gilt die
            Nutzungssperre: ohne freigegebene GPS-Nutzung ist die Nutzung
            untersagt.
          </p>
        </div>

        <p>
          {config.policy_complete
            ? "Tablet-Policy vollständig konfiguriert."
            : "Tablet-Policy nicht vollständig konfiguriert."}
        </p>

        <button type="submit" disabled={busy || !dirty}>
          Konfiguration speichern
        </button>

        {message !== null ? (
          <p role={message.kind === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export interface TaxiControlPanelProps {
  client: TaxiControlClient;
  /** Fuer deterministische Tests injizierbar. */
  createCommandId?: () => string;
  createChangeId?: () => string;
}

/**
 * Einbindbare Taxi-Bedienung fuer taxiweite Pause und versionierte
 * Konfiguration. Keine Navigation, kein HTTP und keine Tablet-Fernsteuerung:
 * der Port wird von aussen injiziert.
 */
export function TaxiControlPanel({
  client,
  createCommandId,
  createChangeId,
}: TaxiControlPanelProps) {
  const [entries, setEntries] = useState<TaxiControlEntry[] | null>(null);
  const entriesRef = useRef<TaxiControlEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTabletId, setSelectedTabletId] = useState<string | null>(
    null,
  );

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const [unclearAttempt, setUnclearAttempt] = useState<CommandAttempt | null>(
    null,
  );

  const aliveRef = useRef(true);
  const loadSeqRef = useRef(0);
  const commandIdFactory = useRef(createCommandId ?? defaultCommandId);
  commandIdFactory.current = createCommandId ?? defaultCommandId;
  const changeIdFactory = useRef(createChangeId ?? defaultCommandId);
  changeIdFactory.current = createChangeId ?? defaultCommandId;

  const commitEntries = useCallback(
    (
      updater: (current: TaxiControlEntry[] | null) => TaxiControlEntry[] | null,
    ) => {
      const next = updater(entriesRef.current);
      entriesRef.current = next;
      setEntries(next);
    },
    [],
  );

  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await client.load();
      if (!aliveRef.current || seq !== loadSeqRef.current) {
        return false;
      }
      commitEntries((current) => mergeSnapshot(current, snapshot));
      return true;
    } catch (error) {
      if (!aliveRef.current || seq !== loadSeqRef.current) {
        return false;
      }
      setLoadError(loadMessage(error));
      return false;
    } finally {
      if (aliveRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [client, commitEntries]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
      loadSeqRef.current += 1;
    };
  }, [load]);

  const resolvedTabletId = (() => {
    if (entries === null) {
      return null;
    }
    if (
      selectedTabletId !== null &&
      entries.some((entry) =>
        entry.taxi.tablets.some(
          (tablet) => tablet.tablet_id === selectedTabletId,
        ),
      )
    ) {
      return selectedTabletId;
    }
    return entries[0]?.taxi.tablets[0]?.tablet_id ?? null;
  })();

  const selectedEntry =
    entries?.find((entry) =>
      entry.taxi.tablets.some(
        (tablet) => tablet.tablet_id === resolvedTabletId,
      ),
    ) ?? null;
  const selectedTablet =
    selectedEntry?.taxi.tablets.find(
      (tablet) => tablet.tablet_id === resolvedTabletId,
    ) ?? null;

  const runCommand = useCallback(
    async (desiredPaused: boolean, retry?: CommandAttempt) => {
      if (busyRef.current) {
        return;
      }
      const targetTaxiId = retry?.taxi_id ?? selectedEntry?.taxi.taxi_id;
      const target =
        entriesRef.current?.find(
          (entry) => entry.taxi.taxi_id === targetTaxiId,
        ) ?? null;
      if (target === null) {
        return;
      }
      const attempt: CommandAttempt =
        retry !== undefined
          ? retry
          : {
              taxi_id: target.taxi.taxi_id,
              command_id: commandIdFactory.current(),
              expected_revision: target.pause.revision,
              desired_paused: desiredPaused,
            };
      busyRef.current = true;
      setBusy(true);
      setMessage(null);
      setUnclearAttempt(null);
      try {
        const result = await client.setDesiredPause({
          taxi_id: attempt.taxi_id,
          command_id: attempt.command_id,
          expected_revision: attempt.expected_revision,
          desired_paused: attempt.desired_paused,
        });
        if (!aliveRef.current) {
          return;
        }
        commitEntries((current) =>
          current === null
            ? current
            : current.map((entry) =>
                entry.taxi.taxi_id === attempt.taxi_id
                  ? applyCommandResult(entry, result)
                  : entry,
              ),
        );
        setMessage({ kind: "status", text: COMMAND_SENT });
        // Bestaetigungen kommen ausschliesslich aus dem Port; kein lokaler
        // Erfolg und keine automatische Wiederholung.
        await load();
      } catch (error) {
        if (!aliveRef.current) {
          return;
        }
        const actionMessage = pauseActionMessage(error);
        setMessage(actionMessage);
        if (
          isTaxiControlPortError(error) &&
          (error.kind === "unclear" || error.kind === "network")
        ) {
          setUnclearAttempt(attempt);
        } else if (
          isTaxiControlPortError(error) &&
          error.kind === "revision_conflict"
        ) {
          // Neu laden, aber nichts automatisch ueberschreiben oder senden.
          await load();
        }
      } finally {
        busyRef.current = false;
        if (aliveRef.current) {
          setBusy(false);
        }
      }
    },
    [client, commitEntries, load, selectedEntry],
  );

  const handleSaved = useCallback(
    (result: UpdateTaxiConfigResult) => {
      commitEntries((current) =>
        current === null
          ? current
          : current.map((entry) =>
              entry.taxi.taxi_id === result.taxi_id
                ? applyConfigResult(entry, result)
                : entry,
            ),
      );
    },
    [commitEntries],
  );

  const tabletSelection =
    entries !== null && entries.length > 0 ? (
      <div>
        <p>Tablet auswählen:</p>
        <ul>
          {entries.flatMap((entry) =>
            entry.taxi.tablets.map((tablet) => (
              <li key={`${entry.taxi.taxi_id}:${tablet.tablet_id}`}>
                <button
                  type="button"
                  aria-pressed={tablet.tablet_id === resolvedTabletId}
                  onClick={() => setSelectedTabletId(tablet.tablet_id)}
                >
                  {entry.taxi.taxi_name}: {tablet.label} auswählen
                </button>
              </li>
            )),
          )}
        </ul>
      </div>
    ) : null;

  return (
    <section aria-label="Taxi-Bedienung">
      <h2>Taxi-Bedienung</h2>

      {loading && entries === null ? <p>Taxidaten werden geladen …</p> : null}

      {loadError !== null ? (
        <div role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={() => void load()}>
            Erneut laden
          </button>
        </div>
      ) : null}

      {entries !== null && entries.length === 0 ? (
        <p>Keine Taxis vorhanden.</p>
      ) : null}

      {tabletSelection}

      {selectedEntry !== null ? (
        <>
          <section aria-label="Pausensteuerung">
            <h3>Pause für {selectedEntry.taxi.taxi_name}</h3>
            <p>Ausgewähltes Taxi: {selectedEntry.taxi.taxi_name}</p>
            <p>
              Ausgewähltes Tablet: {selectedTablet?.label ?? resolvedTabletId}
            </p>
            <p>
              Die Auswahl von {selectedTablet?.label ?? resolvedTabletId}{" "}
              betrifft beide Tablets des Taxis{" "}
              {selectedEntry.taxi.taxi_name}:{" "}
              {selectedEntry.taxi.tablets
                .map((tablet) => tablet.label)
                .join(", ")}
              .
            </p>
            <p>
              Betroffene Tablet-IDs:{" "}
              {selectedEntry.taxi.tablets
                .map((tablet) => tablet.tablet_id)
                .join(", ")}
            </p>
            <p>
              Sollzustand:{" "}
              {selectedEntry.pause.desired_paused ? "Pause" : "Fortsetzen"}{" "}
              (Revision {selectedEntry.pause.revision})
            </p>
            <p>
              Taxi-Gesamtstatus: {overallExecutionStatus(selectedEntry)}
            </p>
            <ul>
              {selectedEntry.taxi.tablets.map((tablet) => (
                <li key={tablet.tablet_id}>
                  {tablet.label}:{" "}
                  {tabletExecutionStatus(selectedEntry, tablet.tablet_id)}
                </li>
              ))}
            </ul>

            <button
              type="button"
              disabled={busy}
              onClick={() => void runCommand(true)}
            >
              Pause
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runCommand(false)}
            >
              Fortsetzen
            </button>
            <button
              type="button"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              Status aktualisieren
            </button>

            {busy ? <p>Auftrag wird gesendet …</p> : null}

            {message !== null ? (
              <p role={message.kind === "error" ? "alert" : "status"}>
                {message.text}
              </p>
            ) : null}

            {unclearAttempt !== null ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void runCommand(
                    unclearAttempt.desired_paused,
                    unclearAttempt,
                  )
                }
              >
                Wiederholen
              </button>
            ) : null}
          </section>

          <TaxiConfigForm
            entry={selectedEntry}
            client={client}
            createChangeId={() => changeIdFactory.current()}
            onReload={load}
            onSaved={handleSaved}
          />
        </>
      ) : null}
    </section>
  );
}

export { TaxiControlPortError, isTaxiControlPortError };
export type {
  AppliedRevision,
  SetDesiredPauseInput,
  SetDesiredPauseResult,
  TaxiControlClient,
  TaxiControlConfig,
  TaxiControlConfigValues,
  TaxiControlEntry,
  TaxiControlErrorKind,
  TaxiControlSnapshot,
  TaxiIdentity,
  TaxiPauseStatus,
  TaxiTablet,
  TaxiTabletConnection,
  UpdateTaxiConfigInput,
  UpdateTaxiConfigResult,
} from "./taxiControlTypes";
