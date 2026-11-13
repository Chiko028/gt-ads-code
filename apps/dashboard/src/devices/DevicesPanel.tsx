import { useCallback, useEffect, useRef, useState } from "react";

import type { AdminDevice, AdminDeviceDetail } from "../admin/adminApi";
import { isAdminApiError, isUnauthorizedError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";

const UNKNOWN = "Unbekannt";
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";
const REVOKE_CONFIRMED_MESSAGE = "wurde vom Server gesperrt.";
const STALE_LIST_MESSAGE =
  "Die Sperrung wurde bestätigt, aber die Geräteliste konnte nicht aktualisiert werden. Die Liste ist veraltet.";
const STALE_DETAIL_MESSAGE =
  "Die Sperrung wurde bestätigt, aber das Gerätedetail konnte nicht aktualisiert werden. Die Detailanzeige ist veraltet.";
const STALE_BOTH_MESSAGE =
  "Die Sperrung wurde bestätigt, aber Liste und Detail konnten nicht aktualisiert werden. Die Anzeige ist veraltet.";

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

/** Leere oder fehlende Werte werden nie als technischer Fehler gedeutet. */
function known(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return UNKNOWN;
  }
  const trimmed = value.trim();
  return trimmed === "" ? UNKNOWN : value;
}

function labelOf(device: AdminDevice): string {
  return device.label === null || device.label.trim() === ""
    ? "Ohne Bezeichnung"
    : device.label;
}

/**
 * Unbekannte Serverwerte werden defensiv dargestellt. Der Client aus CX-026
 * laesst fuer state/connectivity nur die Vertragswerte zu; die Fallbacks
 * sichern zusaetzlich kuenftige oder unerwartete Werte ab.
 */
function stateLabel(state: string): string {
  if (state === "active") {
    return "Aktiv";
  }
  if (state === "revoked") {
    return "Gesperrt";
  }
  return UNKNOWN;
}

function connectivityLabel(connectivity: string): string {
  if (connectivity === "reachable") {
    return "Erreichbar";
  }
  if (connectivity === "last_seen") {
    return "Zuletzt gesehen";
  }
  return UNKNOWN;
}

/**
 * Geraeteliste und -detail auf Basis des Admin-Clients und der Sitzung aus
 * CX-026. Es gibt keinen zweiten Authentifizierungszustand und keine zweite
 * fetch-Abstraktion. Schreibende Aktionen werden nie automatisch wiederholt.
 */
export function DevicesPanel() {
  const { api } = useAdminSession();

  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminDeviceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeConfirmedId, setRevokeConfirmedId] = useState<string | null>(null);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const revokeBusyRef = useRef(false);

  const loadList = useCallback(async (): Promise<boolean> => {
    const seq = ++listSeqRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const result = await api.listDevices();
      if (!aliveRef.current || seq !== listSeqRef.current) {
        return false;
      }
      setDevices(result.items);
      setTruncated(result.truncated);
      return true;
    } catch (error) {
      if (!aliveRef.current || seq !== listSeqRef.current) {
        return false;
      }
      // 401 wird ausschliesslich zentral in der AdminShell behandelt.
      if (isUnauthorizedError(error)) {
        return false;
      }
      setListError(messageFor(error));
      return false;
    } finally {
      if (aliveRef.current && seq === listSeqRef.current) {
        setListLoading(false);
      }
    }
  }, [api]);

  const loadDetail = useCallback(
    async (id: string): Promise<boolean> => {
      const seq = ++detailSeqRef.current;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const loaded = await api.getDevice(id);
        if (
          !aliveRef.current ||
          seq !== detailSeqRef.current ||
          selectedIdRef.current !== id
        ) {
          return false;
        }
        setDetail(loaded);
        return true;
      } catch (error) {
        if (
          !aliveRef.current ||
          seq !== detailSeqRef.current ||
          selectedIdRef.current !== id
        ) {
          return false;
        }
        if (isUnauthorizedError(error)) {
          return false;
        }
        setDetailError(messageFor(error));
        return false;
      } finally {
        if (
          aliveRef.current &&
          seq === detailSeqRef.current &&
          selectedIdRef.current === id
        ) {
          setDetailLoading(false);
        }
      }
    },
    [api],
  );

  useEffect(() => {
    aliveRef.current = true;
    void loadList();
    return () => {
      aliveRef.current = false;
      listSeqRef.current += 1;
      detailSeqRef.current += 1;
      selectedIdRef.current = null;
    };
  }, [loadList]);

  const selectDevice = useCallback(
    (id: string) => {
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setConfirmOpen(false);
      setRevokeError(null);
      setRevokeConfirmedId(null);
      setStaleMessage(null);
      void loadDetail(id);
    },
    [loadDetail],
  );

  const refresh = useCallback(async () => {
    setStaleMessage(null);
    await loadList();
    const id = selectedIdRef.current;
    if (aliveRef.current && id !== null) {
      await loadDetail(id);
    }
  }, [loadList, loadDetail]);

  const confirmRevoke = useCallback(async () => {
    const id = selectedIdRef.current;
    if (id === null || revokeBusyRef.current) {
      return;
    }
    revokeBusyRef.current = true;
    setRevokeBusy(true);
    setRevokeError(null);
    setRevokeConfirmedId(null);
    setStaleMessage(null);
    try {
      await api.revokeDevice(id);
    } catch (error) {
      if (!aliveRef.current) {
        return;
      }
      // Kein lokaler Erfolg, keine automatische Wiederholung.
      if (!isUnauthorizedError(error)) {
        setRevokeError(messageFor(error));
      }
      return;
    } finally {
      revokeBusyRef.current = false;
      if (aliveRef.current) {
        setRevokeBusy(false);
      }
    }
    if (!aliveRef.current) {
      return;
    }
    setConfirmOpen(false);
    setRevokeConfirmedId(id);
    // Erst nach bestaetigtem 204 werden Liste und Detail neu geladen.
    const listOk = await loadList();
    if (!aliveRef.current) {
      return;
    }
    const detailOk = await loadDetail(id);
    if (!aliveRef.current) {
      return;
    }
    if (!listOk && !detailOk) {
      setStaleMessage(STALE_BOTH_MESSAGE);
    } else if (!listOk) {
      setStaleMessage(STALE_LIST_MESSAGE);
    } else if (!detailOk) {
      setStaleMessage(STALE_DETAIL_MESSAGE);
    }
  }, [api, loadList, loadDetail]);

  const devicesRegion = (
    <section aria-label="Geräte">
      <h2>Geräte</h2>
      <div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={listLoading}
        >
          Aktualisieren
        </button>
        {listLoading ? <p>Geräteliste wird geladen …</p> : null}
      </div>

      {listError !== null ? (
        <div role="alert">
          <p>{listError}</p>
          {devices !== null ? (
            <p>Die angezeigte Liste ist möglicherweise veraltet.</p>
          ) : null}
        </div>
      ) : null}

      {listError !== null && devices === null ? (
        <p>Die Geräteliste konnte nicht geladen werden.</p>
      ) : null}

      {truncated ? (
        <p role="status">
          Die Geräteliste ist unvollständig; es werden nicht alle Geräte
          angezeigt.
        </p>
      ) : null}

      {devices !== null && devices.length === 0 && listError === null ? (
        <p>Keine Geräte vorhanden.</p>
      ) : null}

      {devices !== null && devices.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Bezeichnung</th>
              <th scope="col">Hersteller/Modell</th>
              <th scope="col">App-Version</th>
              <th scope="col">OS-Version</th>
              <th scope="col">Status</th>
              <th scope="col">Zuletzt gesehen</th>
              <th scope="col">Erreichbarkeit</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.id}>
                <td>{known(device.id)}</td>
                <td>{labelOf(device)}</td>
                <td>
                  {known(device.manufacturer)} / {known(device.model)}
                </td>
                <td>{known(device.appVersion)}</td>
                <td>{known(device.osVersion)}</td>
                <td>{stateLabel(device.state)}</td>
                <td>{known(device.lastSeenAt)}</td>
                <td>{connectivityLabel(device.connectivity)}</td>
                <td>
                  <button
                    type="button"
                    aria-label={`Details zu ${device.id}`}
                    onClick={() => selectDevice(device.id)}
                  >
                    Details
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );

  const detailRegion =
    selectedId !== null ? (
      <section aria-label="Gerätedetail">
        <h3>Gerät {selectedId}</h3>

        {revokeConfirmedId !== null ? (
          <p role="status">
            Gerät {revokeConfirmedId} {REVOKE_CONFIRMED_MESSAGE}
          </p>
        ) : null}

        {staleMessage !== null ? <p role="alert">{staleMessage}</p> : null}

        {detailLoading ? <p>Gerätedetail wird geladen …</p> : null}
        {detailError !== null ? <p role="alert">{detailError}</p> : null}

        {detail !== null ? (
          <>
            <dl>
              <dt>ID</dt>
              <dd>{known(detail.id)}</dd>
              <dt>Bezeichnung</dt>
              <dd>{labelOf(detail)}</dd>
              <dt>Hersteller</dt>
              <dd>{known(detail.manufacturer)}</dd>
              <dt>Modell</dt>
              <dd>{known(detail.model)}</dd>
              <dt>App-Version</dt>
              <dd>{known(detail.appVersion)}</dd>
              <dt>App-Flavor</dt>
              <dd>{known(detail.appFlavor)}</dd>
              <dt>OS-Version</dt>
              <dd>{known(detail.osVersion)}</dd>
              <dt>SDK-Int</dt>
              <dd>{detail.sdkInt}</dd>
              <dt>Status</dt>
              <dd>{stateLabel(detail.state)}</dd>
              <dt>Erreichbarkeit</dt>
              <dd>{connectivityLabel(detail.connectivity)}</dd>
              <dt>Registriert am</dt>
              <dd>{known(detail.registeredAt)}</dd>
              <dt>Zuletzt gesehen</dt>
              <dd>{known(detail.lastSeenAt)}</dd>
              <dt>Letzter Uhrversatz</dt>
              <dd>{detail.lastClockOffsetMs} ms</dd>
              <dt>Registrierungscode</dt>
              <dd>{known(detail.registrationCodeId)}</dd>
            </dl>

            {revokeConfirmedId === null && detail.state !== "revoked" ? (
              confirmOpen ? (
                <div role="group" aria-label="Sperrbestätigung">
                  <p>
                    Gerät <strong>{detail.id}</strong> wirklich sperren? Die
                    Sperrung kann nicht rückgängig gemacht werden.
                  </p>
                  {revokeError !== null ? (
                    <p role="alert">{revokeError}</p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void confirmRevoke()}
                    disabled={revokeBusy}
                  >
                    Sperren bestätigen
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmOpen(false);
                      setRevokeError(null);
                    }}
                    disabled={revokeBusy}
                  >
                    Abbrechen
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmOpen(true)}>
                  Gerät sperren
                </button>
              )
            ) : null}

            {detail.state === "revoked" ? (
              <p>Dieses Gerät ist bereits gesperrt.</p>
            ) : null}
          </>
        ) : null}
      </section>
    ) : null;

  return (
    <>
      {devicesRegion}
      {detailRegion}
    </>
  );
}

