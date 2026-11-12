import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";

import type {
  AdminApi,
  CreatedRegistrationCode,
  FetchLike,
  RegistrationCode,
  RegistrationCodeStatus,
} from "./adminApi";
import {
  createAdminApi,
  isAdminApiError,
  isUnauthorizedError,
} from "./adminApi";

const STATUS_LABELS: Record<RegistrationCodeStatus, string> = {
  pending: "Offen",
  used: "Verwendet",
  expired: "Abgelaufen",
  revoked: "Widerrufen",
};

const SESSION_EXPIRED_MESSAGE =
  "Die Sitzung ist abgelaufen. Bitte erneut anmelden.";
const LOGOUT_UNCONFIRMED_MESSAGE =
  "Die Abmeldung konnte serverseitig nicht bestätigt werden. Bitte die Verbindung prüfen.";
const UNKNOWN_CREATE_MESSAGE =
  "Der Ausgang der Erzeugung ist unklar. Der Code wurde möglicherweise erstellt. Bitte die Liste neu laden.";
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";

type Phase = "checking" | "check_failed" | "login" | "ready";

export interface AdminSessionContextValue {
  /** Derselbe Client, den auch AdminShell verwendet. */
  api: AdminApi;
  sessionStatus: "checking" | "authenticated" | "unauthenticated";
  /** Zentrale Sitzungsinvalidierung fuer geschuetzte Kindkomponenten. */
  invalidateSession: () => void;
}

const AdminSessionContext = createContext<AdminSessionContextValue | null>(
  null,
);

/** Zugriff auf Client und Sitzungszustand innerhalb von AdminShell. */
export function useAdminSession(): AdminSessionContextValue {
  const value = useContext(AdminSessionContext);
  if (value === null) {
    throw new Error(
      "useAdminSession muss innerhalb von AdminShell verwendet werden.",
    );
  }
  return value;
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function isUnknownCreateOutcome(error: unknown): boolean {
  return (
    isAdminApiError(error) &&
    (error.kind === "network" ||
      error.kind === "server" ||
      error.kind === "invalid_response")
  );
}

export interface AdminShellProps {
  children?: ReactNode;
  /** Injizierbares fetch fuer Client und Tests. */
  fetchImpl?: FetchLike;
  /** Alternative Client-Fabrik; erhaelt die zentrale 401-Behandlung. */
  apiFactory?: (options: { onUnauthorized: () => void }) => AdminApi;
}

/**
 * Admin-Grundgeruest fuer Anmeldung, Abmeldung und Registrierungscodes.
 * Geschuetzte Inhalte werden als children nur im angemeldeten Zustand
 * gerendert und erhalten Client sowie Sitzungsinvalidierung per Context.
 */
export function AdminShell({
  children,
  fetchImpl,
  apiFactory,
}: AdminShellProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [logoutWarning, setLogoutWarning] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [codes, setCodes] = useState<RegistrationCode[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createUnknown, setCreateUnknown] = useState(false);
  const [createdCode, setCreatedCode] = useState<CreatedRegistrationCode | null>(
    null,
  );
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const generationRef = useRef(0);
  const authenticatedRef = useRef(false);
  const loginBusyRef = useRef(false);
  const listInFlightRef = useRef(false);
  const createBusyRef = useRef(false);
  const revokeBusyRef = useRef(false);

  const handleUnauthorized = useCallback(() => {
    const wasAuthenticated = authenticatedRef.current;
    authenticatedRef.current = false;
    generationRef.current += 1;
    setCodes([]);
    setCreatedCode(null);
    setConfirmingId(null);
    setCreateError(null);
    setCreateUnknown(false);
    setListError(null);
    setListLoading(false);
    setRevokeError(null);
    setPassword("");
    setPhase("login");
    setAuthMessage(wasAuthenticated ? SESSION_EXPIRED_MESSAGE : null);
  }, []);

  const api = useMemo(() => {
    if (apiFactory !== undefined) {
      return apiFactory({ onUnauthorized: handleUnauthorized });
    }
    return createAdminApi({ fetchImpl, onUnauthorized: handleUnauthorized });
  }, [apiFactory, fetchImpl, handleUnauthorized]);

  const loadCodes = useCallback(
    async (generation: number): Promise<boolean> => {
      if (listInFlightRef.current) {
        return false;
      }
      listInFlightRef.current = true;
      setListLoading(true);
      setListError(null);
      try {
        const items = await api.listRegistrationCodes();
        if (generation !== generationRef.current) {
          return false;
        }
        setCodes(items);
        return true;
      } catch (error) {
        if (generation !== generationRef.current) {
          return false;
        }
        if (!isUnauthorizedError(error)) {
          setListError(messageFor(error));
        }
        return false;
      } finally {
        listInFlightRef.current = false;
        if (generation === generationRef.current) {
          setListLoading(false);
        }
      }
    },
    [api],
  );

  const checkSession = useCallback(async () => {
    const generation = generationRef.current;
    setPhase("checking");
    setCheckError(null);
    try {
      const items = await api.listRegistrationCodes();
      if (generation !== generationRef.current) {
        return;
      }
      setCodes(items);
      setPhase("ready");
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      if (isUnauthorizedError(error)) {
        setPhase("login");
        setAuthMessage(null);
        return;
      }
      setCheckError(messageFor(error));
      setPhase("check_failed");
    }
  }, [api]);

  useEffect(() => {
    generationRef.current += 1;
    authenticatedRef.current = false;
    setCreatedCode(null);
    setCodes([]);
    setAuthMessage(null);
    setLogoutWarning(null);
    void checkSession();
  }, [checkSession]);

  async function handleLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginBusyRef.current || loggingOut) {
      return;
    }
    loginBusyRef.current = true;
    setLoginBusy(true);
    setAuthMessage(null);
    setLogoutWarning(null);
    const generation = ++generationRef.current;
    let succeeded = false;
    try {
      await api.login(password);
      succeeded = true;
    } catch (error) {
      if (generation === generationRef.current) {
        setAuthMessage(messageFor(error));
      }
    } finally {
      setPassword("");
      loginBusyRef.current = false;
      setLoginBusy(false);
    }
    if (!succeeded || generation !== generationRef.current) {
      return;
    }
    authenticatedRef.current = true;
    setPhase("ready");
    setCodes([]);
    setCreatedCode(null);
    setConfirmingId(null);
    setCreateError(null);
    setCreateUnknown(false);
    setRevokeError(null);
    await loadCodes(generation);
  }

  async function handleLogout() {
    const generation = ++generationRef.current;
    authenticatedRef.current = false;
    setPhase("login");
    setPassword("");
    setCodes([]);
    setCreatedCode(null);
    setConfirmingId(null);
    setCreateError(null);
    setCreateUnknown(false);
    setListError(null);
    setListLoading(false);
    setRevokeError(null);
    setAuthMessage(null);
    setLogoutWarning(null);
    setLoggingOut(true);
    try {
      await api.logout();
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      if (!isUnauthorizedError(error)) {
        setLogoutWarning(LOGOUT_UNCONFIRMED_MESSAGE);
      }
    } finally {
      if (generation === generationRef.current) {
        setLoggingOut(false);
      }
    }
  }

  async function handleCreateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createBusyRef.current) {
      return;
    }
    createBusyRef.current = true;
    setCreating(true);
    setCreateError(null);
    setCreateUnknown(false);
    setCreatedCode(null);
    const generation = generationRef.current;
    const trimmed = label.trim().slice(0, 64);
    try {
      const created = await api.createRegistrationCode(
        trimmed === "" ? undefined : trimmed,
      );
      if (generation !== generationRef.current) {
        return;
      }
      setCreatedCode(created);
      setLabel("");
      await loadCodes(generation);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isUnknownCreateOutcome(error)) {
        setCreateUnknown(true);
        setCreateError(UNKNOWN_CREATE_MESSAGE);
      } else {
        setCreateError(messageFor(error));
      }
    } finally {
      createBusyRef.current = false;
      if (generation === generationRef.current) {
        setCreating(false);
      }
    }
  }

  async function handleReloadAfterUnknown() {
    const generation = generationRef.current;
    setCreateError(null);
    const ok = await loadCodes(generation);
    if (ok && generation === generationRef.current) {
      setCreateUnknown(false);
    }
  }

  async function handleConfirmRevoke(id: string) {
    if (revokeBusyRef.current) {
      return;
    }
    revokeBusyRef.current = true;
    setRevokeBusy(true);
    setRevokeError(null);
    const generation = generationRef.current;
    try {
      await api.revokeRegistrationCode(id);
      if (generation !== generationRef.current) {
        return;
      }
      setConfirmingId(null);
      await loadCodes(generation);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      if (!isUnauthorizedError(error)) {
        setRevokeError(messageFor(error));
      }
    } finally {
      revokeBusyRef.current = false;
      if (generation === generationRef.current) {
        setRevokeBusy(false);
      }
    }
  }

  const contextValue = useMemo<AdminSessionContextValue>(
    () => ({
      api,
      sessionStatus:
        phase === "ready"
          ? "authenticated"
          : phase === "checking"
            ? "checking"
            : "unauthenticated",
      invalidateSession: handleUnauthorized,
    }),
    [api, phase, handleUnauthorized],
  );

  if (phase === "checking") {
    return (
      <main>
        <h1>GT-Ads Verwaltung</h1>
        <p>Anmeldung wird geprüft …</p>
      </main>
    );
  }

  if (phase === "check_failed") {
    return (
      <main>
        <h1>GT-Ads Verwaltung</h1>
        {checkError !== null ? <p role="alert">{checkError}</p> : null}
        <button
          type="button"
          onClick={() => {
            generationRef.current += 1;
            void checkSession();
          }}
        >
          Erneut prüfen
        </button>
      </main>
    );
  }

  if (phase === "login") {
    return (
      <main>
        <h1>GT-Ads Verwaltung</h1>
        <h2>Anmeldung</h2>
        {logoutWarning !== null ? (
          <p role="alert">{logoutWarning}</p>
        ) : null}
        {authMessage !== null ? <p role="alert">{authMessage}</p> : null}
        <form onSubmit={(event) => void handleLoginSubmit(event)} noValidate>
          <label htmlFor="admin-password">Passwort</label>
          <input
            id="admin-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={loginBusy || loggingOut}
          />
          <button type="submit" disabled={loginBusy || loggingOut}>
            Anmelden
          </button>
        </form>
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>GT-Ads Verwaltung</h1>
        <button type="button" onClick={() => void handleLogout()} disabled={loggingOut}>
          Abmelden
        </button>
      </header>

      <section aria-label="Registrierungscodes">
        <h2>Registrierungscodes</h2>

        {createUnknown ? (
          <div role="alert">
            <p>{UNKNOWN_CREATE_MESSAGE}</p>
            <button
              type="button"
              onClick={() => void handleReloadAfterUnknown()}
              disabled={listLoading}
            >
              Liste neu laden
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void handleCreateSubmit(event)} noValidate>
            <label htmlFor="code-label">Bezeichnung (optional)</label>
            <input
              id="code-label"
              name="label"
              type="text"
              maxLength={64}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              disabled={creating}
            />
            <button type="submit" disabled={creating}>
              Code erzeugen
            </button>
          </form>
        )}

        {createError !== null && !createUnknown ? (
          <p role="alert">{createError}</p>
        ) : null}

        {createdCode !== null ? (
          <section aria-label="Erzeugter Registrierungscode">
            <p>
              Code: <code>{createdCode.code}</code>
            </p>
            <p>
              Gültig bis:{" "}
              <time dateTime={createdCode.expiresAt}>
                {createdCode.expiresAt}
              </time>
            </p>
            <button type="button" onClick={() => setCreatedCode(null)}>
              Ausblenden
            </button>
          </section>
        ) : null}

        <div>
          <button
            type="button"
            onClick={() => void loadCodes(generationRef.current)}
            disabled={listLoading}
          >
            Aktualisieren
          </button>
        </div>

        {listError !== null ? <p role="alert">{listError}</p> : null}
        {revokeError !== null ? <p role="alert">{revokeError}</p> : null}
        {listLoading ? <p>Liste wird geladen …</p> : null}

        {!listLoading && codes.length === 0 ? (
          <p>Keine Registrierungscodes vorhanden.</p>
        ) : null}

        {codes.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Bezeichnung</th>
                <th scope="col">Status</th>
                <th scope="col">Erstellt</th>
                <th scope="col">Läuft ab</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((code) => (
                <tr key={code.id}>
                  <td>{code.label ?? "Ohne Bezeichnung"}</td>
                  <td>{STATUS_LABELS[code.status]}</td>
                  <td>
                    <time dateTime={code.createdAt}>{code.createdAt}</time>
                  </td>
                  <td>
                    <time dateTime={code.expiresAt}>{code.expiresAt}</time>
                  </td>
                  <td>
                    {code.status === "pending" ? (
                      confirmingId === code.id ? (
                        <span>
                          <span>Wirklich widerrufen?</span>
                          <button
                            type="button"
                            onClick={() => void handleConfirmRevoke(code.id)}
                            disabled={revokeBusy}
                          >
                            Bestätigen
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            disabled={revokeBusy}
                          >
                            Abbrechen
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(code.id)}
                        >
                          Widerrufen
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <AdminSessionContext.Provider value={contextValue}>
        {children}
      </AdminSessionContext.Provider>
    </main>
  );
}

