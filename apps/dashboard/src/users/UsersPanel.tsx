import { useCallback, useEffect, useRef, useState } from "react";

import type { AdminUser } from "../admin/adminApi";
import { isAdminApiError, isUnauthorizedError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";

const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function statusLabel(status: string): string {
  if (status === "active" || status === "enabled") return "Aktiv";
  if (["disabled", "locked", "inactive", "blocked", "suspended"].includes(status)) {
    return "Gesperrt";
  }
  return "Unbekannt";
}

export function UsersPanel() {
  const { api, sessionStatus } = useAdminSession();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const aliveRef = useRef(true);
  const seqRef = useRef(0);
  const epochRef = useRef(0);

  const load = useCallback(async () => {
    if (sessionStatus !== "authenticated") return;
    const seq = ++seqRef.current;
    const epoch = epochRef.current;
    setUsers(null);
    setError(null);
    setDenied(false);
    setLoading(true);
    try {
      const items = await api.listUsers({
        isCurrent: () =>
          aliveRef.current && seq === seqRef.current && epoch === epochRef.current,
      });
      if (!aliveRef.current || seq !== seqRef.current || epoch !== epochRef.current) return;
      setUsers(items);
    } catch (caught) {
      if (!aliveRef.current || seq !== seqRef.current || epoch !== epochRef.current) return;
      // 401 wird zentral vom vorhandenen Transport invalidiert.
      if (isUnauthorizedError(caught)) return;
      setUsers(null);
      if (isAdminApiError(caught) && caught.kind === "forbidden") setDenied(true);
      else setError(messageFor(caught));
    } finally {
      if (aliveRef.current && seq === seqRef.current && epoch === epochRef.current) {
        setLoading(false);
      }
    }
  }, [api, sessionStatus]);

  useEffect(() => {
    aliveRef.current = true;
    if (sessionStatus !== "authenticated") {
      seqRef.current += 1;
      epochRef.current += 1;
      setUsers(null);
      setLoading(false);
      setError(null);
      setDenied(false);
      return () => {
        aliveRef.current = false;
      };
    }
    void load();
    return () => {
      aliveRef.current = false;
      seqRef.current += 1;
      epochRef.current += 1;
    };
  }, [load, sessionStatus]);

  return (
    <section aria-labelledby="users-heading">
      <h2 id="users-heading">Benutzer</h2>
      <div>
        <button type="button" onClick={() => void load()}>Aktualisieren</button>
      </div>
      {loading ? <p>Benutzerliste wird geladen …</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {denied ? <p role="alert">Zugriff verweigert.</p> : null}
      {!loading && !denied && error === null && users !== null && users.length === 0 ? (
        <p>Keine Benutzer vorhanden.</p>
      ) : null}
      {!denied && error === null && users !== null && users.length > 0 ? (
        <table>
          <thead>
            <tr><th scope="col">Kennung</th><th scope="col">Rolle</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
            {users.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.username}</td>
                <td>{entry.role.trim() === "" ? "Unbekannt" : entry.role}</td>
                <td>{statusLabel(entry.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
