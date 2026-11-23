/**
 * App-Updates aus der Ferne (Betriebsseite, nur Admin).
 *
 * Ablauf fuer den Betreiber:
 *   1. Neue App-Version (APK) mit Versionsnummer und -name hochladen.
 *   2. "Für Pilot freigeben": nur als Pilot markierte Tablets holen sie.
 *   3. Läuft sie dort, "Für alle freigeben".
 * Die Tablets prüfen nach jedem Start und danach alle 6 Stunden und
 * installieren still. Je Tablet sieht man die laufende Version und die
 * letzte Rückmeldung.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import type { FetchLike } from "../admin/adminApi";
import {
  AppUpdatesError,
  createAppUpdatesClient,
  type AppRelease,
  type AppUpdatesClient,
  type AppUpdatesOverview,
  type DeviceUpdateRow,
  type Rollout,
} from "./appUpdatesApi";

export interface AppUpdatesPanelProps {
  readonly fetchImpl?: FetchLike;
  readonly client?: AppUpdatesClient;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: AppUpdatesOverview }
  | { readonly kind: "error"; readonly message: string };

const ROLLOUT_TEXT: Record<Rollout, string> = {
  none: "Nicht verteilt",
  pilot: "Nur Pilot-Tablets",
  all: "Alle Tablets",
};

const REPORT_TEXT = {
  downloaded: "Geladen",
  installed: "Installiert",
  failed: "Fehlgeschlagen",
} as const;

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("de-AT", { timeZone: "Europe/Vienna", dateStyle: "short", timeStyle: "short" });
}

function formatSize(bytes: number): string {
  return (bytes / 1_000_000).toLocaleString("de-AT", { maximumFractionDigits: 1 }) + " MB";
}

function messageOf(error: unknown): string {
  return error instanceof AppUpdatesError ? error.message : "Unerwarteter Fehler.";
}

function deviceName(device: DeviceUpdateRow): string {
  return device.label ?? "Tablet " + device.id.slice(0, 8);
}

function taxiName(device: DeviceUpdateRow): string {
  if (device.taxiId === null) return "–";
  return device.taxiName === null ? device.taxiId : device.taxiName + " (" + device.taxiId + ")";
}

export function AppUpdatesPanel({ fetchImpl, client: injected }: AppUpdatesPanelProps) {
  const client = useMemo(() => injected ?? createAppUpdatesClient({ fetchImpl }), [injected, fetchImpl]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [versionCode, setVersionCode] = useState("");
  const [versionName, setVersionName] = useState("");
  const [notes, setNotes] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await client.overview();
      setState({ kind: "ready", data });
    } catch (error) {
      setState({ kind: "error", message: messageOf(error) });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      await action();
      setNotice(success);
      await load();
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null) {
      setActionError("Bitte eine APK-Datei auswählen.");
      return;
    }
    const name = versionName.trim();
    await run(async () => {
      await client.upload({ file, versionCode, versionName, notes });
      setFile(null);
      setVersionCode("");
      setVersionName("");
      setNotes("");
      setFileInputKey((key) => key + 1);
    }, "Version " + name + " hochgeladen. Sie ist noch nicht verteilt.");
  }

  function rolloutButtons(release: AppRelease) {
    const label = "Version " + release.versionName;
    const buttons: Array<{ rollout: Rollout; text: string }> = [];
    if (release.rollout !== "pilot") buttons.push({ rollout: "pilot", text: "Für Pilot freigeben" });
    if (release.rollout !== "all") buttons.push({ rollout: "all", text: "Für alle freigeben" });
    if (release.rollout !== "none") buttons.push({ rollout: "none", text: "Zurückziehen" });
    return buttons.map((button) => (
      <button
        key={button.rollout}
        type="button"
        disabled={busy}
        aria-label={button.text + ": " + label}
        onClick={() =>
          void run(
            () => client.setRollout(release.id, button.rollout),
            label + ": " + ROLLOUT_TEXT[button.rollout] + ".",
          )
        }
      >
        {button.text}
      </button>
    ));
  }

  return (
    <section aria-labelledby="app-updates-heading" className="gt-app-updates">
      <h2 id="app-updates-heading">App-Updates</h2>
      <p>
        Neue App-Versionen kommen über den Server auf die Tablets – ohne Zugriff vor Ort. Erst für
        Pilot-Tablets freigeben, prüfen, dann für alle. Die Tablets fragen nach jedem Start und danach
        alle 6 Stunden nach und installieren still. Eine ältere Version lässt sich nicht zurückspielen;
        eine Korrektur ist immer eine neue, höhere Version.
      </p>

      <form onSubmit={(event) => void onUpload(event)} aria-label="Neue App-Version hochladen">
        <h3>Neue Version hochladen</h3>
        <label>
          APK-Datei
          <input
            key={fileInputKey}
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        <label>
          Versionsnummer
          <input
            type="text"
            inputMode="numeric"
            value={versionCode}
            onChange={(event) => setVersionCode(event.currentTarget.value)}
            placeholder="z. B. 3"
          />
        </label>
        <label>
          Versionsname
          <input
            type="text"
            value={versionName}
            onChange={(event) => setVersionName(event.currentTarget.value)}
            placeholder="z. B. 0.3.0"
          />
        </label>
        <label>
          Notiz (optional)
          <input type="text" value={notes} maxLength={500} onChange={(event) => setNotes(event.currentTarget.value)} />
        </label>
        <button type="submit" disabled={busy}>
          Hochladen
        </button>
      </form>

      {notice !== null ? <p role="status">{notice}</p> : null}
      {actionError !== null ? <p role="alert">{actionError}</p> : null}

      <p>
        <button type="button" disabled={busy} onClick={() => void load()}>
          Aktualisieren
        </button>
      </p>

      {state.kind === "loading" ? <p role="status">App-Versionen werden geladen …</p> : null}
      {state.kind === "error" ? <p role="alert">{state.message}</p> : null}
      {state.kind === "ready" ? (
        <>
          <h3>Versionen</h3>
          {state.data.releases.length === 0 ? (
            <p>Noch keine Version hochgeladen.</p>
          ) : (
            <table aria-label="App-Versionen">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Hochgeladen</th>
                  <th scope="col">Verteilung</th>
                  <th scope="col">Läuft auf</th>
                  <th scope="col">Fehler</th>
                  <th scope="col">Aktion</th>
                </tr>
              </thead>
              <tbody>
                {state.data.releases.map((release) => (
                  <tr key={release.id}>
                    <td>
                      {release.versionName} (Nr. {release.versionCode})
                      {release.notes !== "" ? <div>{release.notes}</div> : null}
                    </td>
                    <td>
                      {formatTime(release.createdAt)}, {formatSize(release.sizeBytes)}
                    </td>
                    <td>{ROLLOUT_TEXT[release.rollout]}</td>
                    <td>{release.counts.installed} Tablets</td>
                    <td>{release.counts.failed}</td>
                    <td>{rolloutButtons(release)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Tablets</h3>
          {state.data.devices.length === 0 ? (
            <p>Noch keine Tablets registriert.</p>
          ) : (
            <table aria-label="App-Version je Tablet">
              <thead>
                <tr>
                  <th scope="col">Taxi</th>
                  <th scope="col">Tablet</th>
                  <th scope="col">Laufende Version</th>
                  <th scope="col">Pilot-Tablet</th>
                  <th scope="col">Letzte Update-Meldung</th>
                  <th scope="col">Android</th>
                </tr>
              </thead>
              <tbody>
                {state.data.devices.map((device) => (
                  <tr key={device.id}>
                    <td>{taxiName(device)}</td>
                    <td>
                      {deviceName(device)}
                      {device.state !== "active" ? " (gesperrt)" : ""}
                    </td>
                    <td>{device.appVersion}</td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={"Pilot-Tablet: " + deviceName(device)}
                        checked={device.updateChannel === "pilot"}
                        disabled={busy}
                        onChange={(event) => {
                          const pilot = event.currentTarget.checked;
                          void run(
                            () => client.setChannel(device.id, pilot ? "pilot" : "stable"),
                            deviceName(device) + (pilot ? " ist jetzt Pilot-Tablet." : " ist kein Pilot-Tablet mehr."),
                          );
                        }}
                      />
                    </td>
                    <td>
                      {device.lastReport === null
                        ? "–"
                        : REPORT_TEXT[device.lastReport.status] +
                          " (" +
                          device.lastReport.versionName +
                          (device.lastReport.detail !== null ? ", " + device.lastReport.detail : "") +
                          ") am " +
                          formatTime(device.lastReport.reportedAt)}
                    </td>
                    <td>{device.osVersion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}
