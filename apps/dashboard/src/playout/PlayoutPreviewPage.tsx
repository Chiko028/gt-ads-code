/**
 * CX-044 / R-304: kleine lesende Ausspielungs-Vorschau.
 *
 * Die Seite bindet in die vorhandene CX-034-Navigation ein. Sie verwendet
 * denselben API-Client wie die Taxi-Seite (createFleetClient) und damit die
 * vorhandene Cookie-Sitzung. Es gibt weder einen Videoplayer noch Polling,
 * Bearbeiten oder Veroeffentlichen.
 *
 * Ausdruecklich gezeigt wird der veroeffentlichte Sollplan, nicht die
 * bestaetigte Wiedergabe auf einem Tablet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FetchLike } from "../admin/adminApi";
import { isAdminApiError, isUnauthorizedError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";
import type {
  FleetClient,
  FleetTaxi,
  FleetTransport,
  PlayoutPreview,
} from "../fleet/fleetApi";
import { createFleetClient } from "../fleet/fleetApi";

const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";
const EMPTY_MANIFEST_MESSAGE = "Noch kein veröffentlichtes Manifest.";
const SOLLPLAN_NOTICE =
  "Veröffentlichter Sollplan – nicht die bestätigte Wiedergabe auf dem Tablet.";

export interface PlayoutPreviewPageProps {
  /** Injizierbarer Transport fuer Tests; niemals eine echte Netzverbindung. */
  readonly transport?: FleetTransport;
  /** Injizierbares fetch, falls kein Transport angegeben ist. */
  readonly fetchImpl?: FetchLike;
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function taxiLabel(taxi: FleetTaxi): string {
  return taxi.displayName.trim() === ""
    ? taxi.id
    : taxi.id + " – " + taxi.displayName;
}

export function PlayoutPreviewPage({
  transport,
  fetchImpl,
}: PlayoutPreviewPageProps = {}) {
  const { invalidateSession } = useAdminSession();

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const previewSeqRef = useRef(0);

  const [taxis, setTaxis] = useState<FleetTaxi[] | null>(null);
  const [taxiError, setTaxiError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<PlayoutPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const expireSession = useCallback(() => {
    generationRef.current += 1;
    invalidateSession();
  }, [invalidateSession]);

  const getSessionGeneration = useCallback(
    () => generationRef.current,
    [],
  );

  const client: FleetClient = useMemo(
    () =>
      createFleetClient({
        transport,
        fetchImpl,
        onUnauthorized: expireSession,
        getSessionGeneration,
      }),
    [transport, fetchImpl, expireSession, getSessionGeneration],
  );

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current;
    void (async () => {
      try {
        const list = await client.listTaxis();
        if (!mountedRef.current || generation !== generationRef.current) {
          return;
        }
        setTaxis(list);
        setTaxiError(null);
      } catch (error) {
        if (!mountedRef.current || generation !== generationRef.current) {
          return;
        }
        if (isUnauthorizedError(error)) {
          return;
        }
        setTaxiError(messageFor(error));
      }
    })();

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      previewSeqRef.current += 1;
    };
  }, [client]);

  useEffect(() => {
    const taxiId = selectedId;
    const seq = ++previewSeqRef.current;

    if (taxiId === "") {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    const generation = generationRef.current;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);

    void (async () => {
      try {
        const result = await client.getPlayoutPreview(taxiId);
        if (
          !mountedRef.current ||
          generation !== generationRef.current ||
          seq !== previewSeqRef.current
        ) {
          return;
        }
        setPreview(result);
      } catch (error) {
        if (
          !mountedRef.current ||
          generation !== generationRef.current ||
          seq !== previewSeqRef.current
        ) {
          return;
        }
        if (isUnauthorizedError(error)) {
          return;
        }
        setPreviewError(messageFor(error));
      } finally {
        if (
          mountedRef.current &&
          generation === generationRef.current &&
          seq === previewSeqRef.current
        ) {
          setPreviewLoading(false);
        }
      }
    })();

    return () => {
      // Ein verspaeteter Abruf des vorherigen Taxis verliert seine Sequenz
      // und darf die aktuelle Auswahl nie ueberschreiben.
      if (seq === previewSeqRef.current) {
        previewSeqRef.current += 1;
      }
    };
  }, [selectedId, client]);

  return (
    <section aria-label="Ausspielung" data-page-state="playout-preview">
      <h2 id="page-heading">Ausspielung</h2>
      <p>{SOLLPLAN_NOTICE}</p>

      {taxiError !== null ? (
        <p role="alert">{taxiError}</p>
      ) : taxis === null ? (
        <p role="status">Taxis werden geladen …</p>
      ) : taxis.length === 0 ? (
        <p>Keine Taxis vorhanden.</p>
      ) : (
        <p>
          <label htmlFor="playout-preview-taxi">Taxi</label>{" "}
          <select
            id="playout-preview-taxi"
            value={selectedId}
            onChange={(event) => {
              setSelectedId(event.target.value);
            }}
          >
            <option value="">Bitte wählen</option>
            {taxis.map((taxi) => (
              <option key={taxi.id} value={taxi.id}>
                {taxiLabel(taxi)}
              </option>
            ))}
          </select>
        </p>
      )}

      {previewError !== null ? <p role="alert">{previewError}</p> : null}

      {previewLoading ? (
        <p role="status">Vorschau wird geladen …</p>
      ) : null}

      {selectedId !== "" && preview !== null ? (
        <section aria-label="Veröffentlichter Sollplan">
          {preview.manifestVersion === null ? (
            <p>{EMPTY_MANIFEST_MESSAGE}</p>
          ) : (
            <>
              <p>
                Manifest-Version: <span>{preview.manifestVersion}</span>
              </p>
              <table>
                <caption>Geordnete Einträge</caption>
                <thead>
                  <tr>
                    <th scope="col">Position</th>
                    <th scope="col">Medienkennung</th>
                    <th scope="col">Dauer</th>
                    <th scope="col">Gültigkeitsfenster</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.entries.map((entry, index) => (
                    <tr key={entry.mediaId + ":" + String(index)}>
                      <td>{index + 1}</td>
                      <td>{entry.mediaId}</td>
                      <td>{entry.durationMs} ms</td>
                      <td>
                        {entry.startAt} – {entry.endAt}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      ) : null}
    </section>
  );
}

