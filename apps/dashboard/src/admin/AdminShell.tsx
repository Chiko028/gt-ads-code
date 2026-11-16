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
  AdminSessionRole,
  CreatedRegistrationCode,
  FetchLike,
  RecoveryCodeSet,
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
const UNKNOWN_RECOVERY_CODES_MESSAGE =
  "Der Ausgang der Erzeugung ist unklar. Die Codes wurden möglicherweise erstellt und können nicht erneut abgerufen werden. Eine neue Ausgabe erfordert eine neue bewusste Bestätigung und einen gültigen TOTP-Code.";
const RECOVERY_CODES_STORAGE_HINT =
  "Bewahren Sie diese Codes außerhalb der Anwendung sicher auf. Sie werden nur einmal angezeigt und können später nicht erneut abgerufen werden.";
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";

type Phase = "checking" | "check_failed" | "login" | "mfa" | "ready";
type MfaMode = "totp" | "recovery";

export interface AdminSessionContextValue {
  /** Derselbe Client, den auch AdminShell verwendet. */
  api: AdminApi;
  sessionStatus: "checking" | "authenticated" | "unauthenticated";
  /** Rolle der angemeldeten Sitzung; Codesatzverwaltung ist Admin-only. */
  role: AdminSessionRole;
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

/**
 * Wie useAdminSession, aber ohne Fehler ausserhalb der AdminShell. Die
 * Statistikseite bleibt dadurch auch als eigenstaendige, injizierte Ansicht
 * testbar; ohne Shell entfaellt nur die zentrale Sitzungsinvalidierung.
 */
export function useOptionalAdminSession(): AdminSessionContextValue | null {
  return useContext(AdminSessionContext);
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

interface RecoveryCodeSetDialogProps {
  api: AdminApi;
  onClose: () => void;
}

/**
 * Bewusste, einmalige Codesatz-Ausgabe. Der Klartext lebt ausschliesslich im
 * lokalen State dieses Dialogs und wird beim Schliessen bzw. Unmount
 * verworfen. Es gibt weder Clipboard-Zugriff noch Download, Telemetrie oder
 * Web-Storage.
 */
function RecoveryCodeSetDialog({ api, onClose }: RecoveryCodeSetDialogProps) {
  const [totpCode, setTotpCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSet, setCodeSet] = useState<RecoveryCodeSet | null>(null);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      // Klartext- und TOTP-State werden mit dem Dialog verworfen.
      aliveRef.current = false;
    };
  }, []);

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) {
      return;
    }
    if (!confirmed) {
      setError("Bitte die Warnung ausdrücklich bestätigen.");
      return;
    }
    if (!/^[0-9]{6}$/.test(totpCode)) {
      setError("Bitte einen sechsstelligen TOTP-Code eingeben.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setCodeSet(null);
    try {
      const issued = await api.generateRecoveryCodes(totpCode);
      if (!aliveRef.current) {
        return;
      }
      setCodeSet(issued);
      setTotpCode("");
      setConfirmed(false);
    } catch (caught) {
      if (!aliveRef.current) {
        return;
      }
      // 401 wird zentral ueber die vorhandene Sitzungskonvention behandelt.
      if (isUnauthorizedError(caught)) {
        return;
      }
      // Keine automatische Wiederholung: der Nutzer muss den Vorgang neu und
      // bewusst ausloesen. Ein unklarer Ausgang bedeutet, dass die Codes
      // moeglicherweise existieren, aber nicht erneut abrufbar sind.
      setTotpCode("");
      setConfirmed(false);
      setCodeSet(null);
      setError(
        isUnknownCreateOutcome(caught)
          ? UNKNOWN_RECOVERY_CODES_MESSAGE
          : messageFor(caught),
      );
    } finally {
      if (aliveRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  function close() {
    setCodeSet(null);
    setTotpCode("");
    setConfirmed(false);
    setError(null);
    onClose();
  }

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Wiederherstellungscodes"
    >
      <h2>Wiederherstellungscodes</h2>
      {codeSet === null ? (
        <form onSubmit={(event) => void handleGenerate(event)} noValidate>
          <p>
            Ein neuer Codesatz macht alle früheren Wiederherstellungscodes
            sofort ungültig.
          </p>
          <p>{RECOVERY_CODES_STORAGE_HINT}</p>
          <label htmlFor="recovery-codes-totp">TOTP-Code (6 Ziffern)</label>
          <input
            id="recovery-codes-totp"
            name="totp_code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value)}
            disabled={busy}
          />
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={busy}
            />
            Ich bestätige, dass ein neuer Codesatz alle früheren Codes
            ungültig macht.
          </label>
          <button type="submit" disabled={busy}>
            Codesatz erzeugen
          </button>
          <button type="button" onClick={close} disabled={busy}>
            Schließen
          </button>
          {error !== null ? <p role="alert">{error}</p> : null}
        </form>
      ) : (
        <div>
          <p role="status">Der Codesatz wurde erzeugt.</p>
          <p>{RECOVERY_CODES_STORAGE_HINT}</p>
          <ol aria-label="Neue Wiederherstellungscodes">
            {codeSet.codes.map((code, index) => (
              <li key={index}>
                <code>{code}</code>
              </li>
            ))}
          </ol>
          <p>
            Erstellt am{" "}
            <time dateTime={codeSet.createdAt}>{codeSet.createdAt}</time>
          </p>
          <button type="button" onClick={close}>
            Schließen
          </button>
        </div>
      )}
    </section>
  );
}

export interface AdminShellProps {
  children?: ReactNode;
  /** Injizierbares fetch fuer Client und Tests. */
  fetchImpl?: FetchLike;
  /**
   * Erzwingt nach der Passwortpruefung den zweiten Faktor. Ohne Angabe
   * entscheidet ein optionaler mfa_required-Hinweis der Login-Antwort; das
   * bisherige 204-Verhalten bleibt damit unveraendert.
   */
  mfaRequired?: boolean;
  /** Kompatible Aliase fuer bestehende Aufrufer und Vorarbeiten. */
  requireMfa?: boolean;
  mfaEnabled?: boolean;
  /** Rollenkontext der Sitzung; Standard ist die bestehende Admin-Anmeldung. */
  role?: AdminSessionRole;
  sessionRole?: AdminSessionRole;
  /** Alternative Client-Fabrik; erhaelt die zentrale 401-Behandlung. */
  apiFactory?: (options: {
    onUnauthorized: () => void;
    getSessionGeneration: () => number;
  }) => AdminApi;
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
  mfaRequired,
  requireMfa,
  mfaEnabled,
  role,
  sessionRole,
}: AdminShellProps) {
  const explicitRole = role ?? sessionRole;
  const forceMfa =
    mfaRequired === true || requireMfa === true || mfaEnabled === true;
  const [phase, setPhase] = useState<Phase>("checking");
  const [activeRole, setActiveRole] = useState<AdminSessionRole>(
    explicitRole ?? "Admin",
  );
  const [mfaMode, setMfaMode] = useState<MfaMode>("totp");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [showRecoveryCodeSet, setShowRecoveryCodeSet] = useState(false);
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
  const mfaBusyRef = useRef(false);
  const listSeqRef = useRef(0);
  /** Generation, die die laufende Erstellung besitzt. */
  const createBusyRef = useRef<number | null>(null);
  /** Generation, die den laufenden Widerruf besitzt. */
  const revokeBusyRef = useRef<number | null>(null);

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
    setCreating(false);
    setRevokeBusy(false);
    setLoggingOut(false);
    setMfaMode("totp");
    setMfaCode("");
    setMfaBusy(false);
    setMfaError(null);
    setShowRecoveryCodeSet(false);
    createBusyRef.current = null;
    revokeBusyRef.current = null;
    mfaBusyRef.current = false;
    setPassword("");
    setPhase("login");
    setAuthMessage(wasAuthenticated ? SESSION_EXPIRED_MESSAGE : null);
  }, []);

  const getSessionGeneration = useCallback(() => generationRef.current, []);

  const api = useMemo(() => {
    if (apiFactory !== undefined) {
      return apiFactory({
        onUnauthorized: handleUnauthorized,
        getSessionGeneration,
      });
    }
    return createAdminApi({
      fetchImpl,
      onUnauthorized: handleUnauthorized,
      getSessionGeneration,
    });
  }, [apiFactory, fetchImpl, handleUnauthorized, getSessionGeneration]);

  const loadCodes = useCallback(
    async (generation: number): Promise<boolean> => {
      if (generation !== generationRef.current) {
        return false;
      }
      // Jede Abfrage traegt eine laufende Nummer. Eine neuere Abfrage
      // ersetzt eine noch laufende aeltere, statt verworfen zu werden.
      const seq = ++listSeqRef.current;
      setListLoading(true);
      setListError(null);
      try {
        const items = await api.listRegistrationCodes();
        if (generation !== generationRef.current || seq !== listSeqRef.current) {
          return false;
        }
        setCodes(items);
        return true;
      } catch (error) {
        if (generation !== generationRef.current || seq !== listSeqRef.current) {
          return false;
        }
        if (!isUnauthorizedError(error)) {
          // Ein 403 auf die Registrierungscodeverwaltung kennzeichnet eine
          // Operator-Sitzung; die Codesatzverwaltung bleibt dann verborgen.
          if (isAdminApiError(error) && error.kind === "forbidden") {
            setActiveRole("Operator");
          }
          setListError(messageFor(error));
        }
        return false;
      } finally {
        if (
          generation === generationRef.current &&
          seq === listSeqRef.current
        ) {
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
    setMfaMode("totp");
    setMfaCode("");
    setMfaBusy(false);
    setMfaError(null);
    setShowRecoveryCodeSet(false);
    mfaBusyRef.current = false;
    if (explicitRole !== undefined) {
      setActiveRole(explicitRole);
    }
    void checkSession();
  }, [checkSession, explicitRole]);

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
    let loginResult: Awaited<ReturnType<AdminApi["login"]>> = undefined;
    try {
      loginResult = await api.login(password);
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

    const nextRole: AdminSessionRole =
      explicitRole ?? loginResult?.role ?? "Admin";
    const requiresMfa = forceMfa || loginResult?.mfaRequired === true;
    setActiveRole(nextRole);
    // Die Passwort-Vorsitzung ist bereits eine gueltige Sitzung; eine 401
    // im zweiten Faktor bedeutet daher "Sitzung abgelaufen".
    authenticatedRef.current = true;

    if (requiresMfa) {
      // Die Passwort-Vorsitzung bleibt bestehen; die zweite Faktor-Pruefung
      // arbeitet auf derselben Sitzung und demselben Fehlversuchszaehler.
      setPhase("mfa");
      setMfaMode("totp");
      setMfaCode("");
      setMfaError(null);
      setMfaBusy(false);
      mfaBusyRef.current = false;
      setShowRecoveryCodeSet(false);
      return;
    }

    setPhase("ready");
    setCodes([]);
    setCreatedCode(null);
    setConfirmingId(null);
    setCreateError(null);
    setCreateUnknown(false);
    setRevokeError(null);
    setCreating(false);
    setRevokeBusy(false);
    setListLoading(false);
    setShowRecoveryCodeSet(false);
    createBusyRef.current = null;
    revokeBusyRef.current = null;
    await loadCodes(generation);
  }

  function switchMfaMode(next: MfaMode) {
    if (mfaBusyRef.current) {
      return;
    }
    setMfaMode(next);
    setMfaCode("");
    setMfaError(null);
  }

  async function handleMfaSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mfaBusyRef.current || loggingOut) {
      return;
    }
    const code = mfaCode.trim();
    if (mfaMode === "totp" && !/^[0-9]{6}$/.test(code)) {
      setMfaError("Bitte einen sechsstelligen TOTP-Code eingeben.");
      return;
    }
    if (mfaMode === "recovery" && code === "") {
      setMfaError("Bitte einen Wiederherstellungscode eingeben.");
      return;
    }

    mfaBusyRef.current = true;
    setMfaBusy(true);
    setMfaError(null);
    const generation = generationRef.current;
    try {
      if (mfaMode === "totp") {
        await api.verifyTotpCode(code);
      } else {
        await api.verifyRecoveryCode(code);
      }
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      // 401 verlaesst die Vorsitzung ueber die vorhandene zentrale
      // Fehlerkonvention; 403, Validierung und 429 bleiben am Schritt.
      if (!isUnauthorizedError(error)) {
        setMfaError(messageFor(error));
      }
      return;
    } finally {
      if (mfaBusyRef.current) {
        mfaBusyRef.current = false;
        if (generation === generationRef.current) {
          setMfaBusy(false);
        }
      }
    }

    if (generation !== generationRef.current) {
      return;
    }
    authenticatedRef.current = true;
    setPhase("ready");
    setMfaCode("");
    setMfaError(null);
    setCodes([]);
    setCreatedCode(null);
    setConfirmingId(null);
    setCreateError(null);
    setCreateUnknown(false);
    setListError(null);
    setRevokeError(null);
    setShowRecoveryCodeSet(false);
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
    setCreating(false);
    setRevokeBusy(false);
    setMfaMode("totp");
    setMfaCode("");
    setMfaBusy(false);
    setMfaError(null);
    setShowRecoveryCodeSet(false);
    createBusyRef.current = null;
    revokeBusyRef.current = null;
    mfaBusyRef.current = false;
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
    const generation = generationRef.current;
    if (createBusyRef.current === generation) {
      return;
    }
    createBusyRef.current = generation;
    setCreating(true);
    setCreateError(null);
    setCreateUnknown(false);
    setCreatedCode(null);
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
      if (createBusyRef.current === generation) {
        createBusyRef.current = null;
        if (generation === generationRef.current) {
          setCreating(false);
        }
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
    const generation = generationRef.current;
    if (revokeBusyRef.current === generation) {
      return;
    }
    revokeBusyRef.current = generation;
    setRevokeBusy(true);
    setRevokeError(null);
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
      if (revokeBusyRef.current === generation) {
        revokeBusyRef.current = null;
        if (generation === generationRef.current) {
          setRevokeBusy(false);
        }
      }
    }
  }

  const contextValue = useMemo<AdminSessionContextValue>(
    () => ({
      api,
      role: activeRole,
      sessionStatus:
        phase === "ready"
          ? "authenticated"
          : phase === "checking"
            ? "checking"
            : "unauthenticated",
      invalidateSession: handleUnauthorized,
    }),
    [api, activeRole, phase, handleUnauthorized],
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

  if (phase === "mfa") {
    return (
      <main>
        <h1>GT-Ads Verwaltung</h1>
        <h2>Zwei-Faktor-Anmeldung</h2>
        {mfaError !== null ? <p role="alert">{mfaError}</p> : null}
        {mfaMode === "totp" ? (
          <>
            <p>Bitte den aktuellen Code aus der Authenticator-App eingeben.</p>
            <form onSubmit={(event) => void handleMfaSubmit(event)} noValidate>
              <label htmlFor="admin-totp-code">TOTP-Code</label>
              <input
                id="admin-totp-code"
                name="totp_code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                disabled={mfaBusy}
              />
              <button type="submit" disabled={mfaBusy}>
                Anmelden
              </button>
            </form>
            <button
              type="button"
              onClick={() => switchMfaMode("recovery")}
              disabled={mfaBusy}
            >
              Wiederherstellungscode verwenden
            </button>
          </>
        ) : (
          <>
            <p>
              Geben Sie einen der zuvor gespeicherten
              Wiederherstellungscodes ein.
            </p>
            <form onSubmit={(event) => void handleMfaSubmit(event)} noValidate>
              <label htmlFor="admin-recovery-code">
                Wiederherstellungscode
              </label>
              <input
                id="admin-recovery-code"
                name="recovery_code"
                type="text"
                autoComplete="one-time-code"
                maxLength={64}
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                disabled={mfaBusy}
              />
              <button type="submit" disabled={mfaBusy}>
                Mit Wiederherstellungscode anmelden
              </button>
            </form>
            <button
              type="button"
              onClick={() => switchMfaMode("totp")}
              disabled={mfaBusy}
            >
              Zurück zur TOTP-Eingabe
            </button>
          </>
        )}
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

      {activeRole === "Admin" ? (
        <section aria-label="Sicherheit">
          <h2>Sicherheit</h2>
          <button
            type="button"
            onClick={() => setShowRecoveryCodeSet(true)}
          >
            Wiederherstellungscodes erzeugen
          </button>
        </section>
      ) : null}

      {showRecoveryCodeSet && activeRole === "Admin" ? (
        <RecoveryCodeSetDialog
          api={api}
          onClose={() => setShowRecoveryCodeSet(false)}
        />
      ) : null}

      <AdminSessionContext.Provider value={contextValue}>
        {children}
      </AdminSessionContext.Provider>
    </main>
  );
}

