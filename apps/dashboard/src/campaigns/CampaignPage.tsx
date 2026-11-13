/**
 * CX-040 / R-207: eingebundene Kampagnenseite.
 *
 * Ein gemeinsames Formular fuer Anlegen und Bearbeiten zeigt nur die
 * vorhandenen fixed_slot-Felder: Kunde, Medium, Laufzeit sowie direkte
 * Taxi- und Gruppenziele. Statusaktionen folgen der Zustandsmaschine aus
 * CX-038; Beenden und Archivieren verlangen eine Bestaetigung. Schreibende
 * Anfragen sind waehrend der Mutation gesperrt, es gibt keine optimistische
 * Anzeige, und ein Versionskonflikt laedt neu statt still zu ueberschreiben.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import type { FetchLike } from "../admin/adminApi";
import { isAdminApiError, isUnauthorizedError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";
import type {
  Campaign,
  CampaignStatus,
  CustomerOption,
  MediaOption,
} from "./campaignApi";
import { createCampaignClient } from "./campaignApi";
import { MediaPreview } from "./MediaPreview";

const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Entwurf",
  active: "Aktiv",
  paused: "Pausiert",
  finished: "Beendet",
};

const RUNTIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_TARGET_LENGTH = 128;

const LOAD_FAILED_MESSAGE = "Die Kampagnen konnten nicht geladen werden.";
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";
const CONFLICT_MESSAGE =
  "Die Kampagne wurde inzwischen geändert. Die Daten wurden neu geladen. Bitte die Kampagne erneut auswählen und bewusst neu bearbeiten.";

type ConfirmAction = "finish" | "archive";

interface ConfirmState {
  readonly campaignId: string;
  readonly action: ConfirmAction;
}

interface EditingState {
  /** null bedeutet: neue Kampagne. */
  readonly campaignId: string | null;
}

interface FormState {
  readonly customerId: string;
  readonly mediaId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly taxiIds: readonly string[];
  readonly groupIds: readonly string[];
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function emptyForm(): FormState {
  return {
    customerId: "",
    mediaId: "",
    startAt: "",
    endAt: "",
    taxiIds: [],
    groupIds: [],
  };
}

function formFrom(campaign: Campaign): FormState {
  return {
    customerId: campaign.customerId,
    mediaId: campaign.mediaId,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    taxiIds: [...campaign.taxiIds],
    groupIds: [...campaign.groupIds],
  };
}

function validateForm(form: FormState, active: boolean): string | null {
  if (form.customerId.trim() === "") {
    return "Bitte einen Kunden wählen.";
  }
  if (form.mediaId.trim() === "") {
    return "Bitte ein Medium wählen.";
  }
  if (
    !RUNTIME_PATTERN.test(form.startAt.trim()) ||
    !RUNTIME_PATTERN.test(form.endAt.trim())
  ) {
    return 'Laufzeit bitte als "YYYY-MM-DDTHH:mm:ss.SSSZ" (UTC) eingeben.';
  }
  const start = Date.parse(form.startAt.trim());
  const end = Date.parse(form.endAt.trim());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return "Der Endzeitpunkt muss nach dem Startzeitpunkt liegen.";
  }
  if (active && form.taxiIds.length + form.groupIds.length === 0) {
    return "Eine aktive Kampagne braucht mindestens ein Taxi- oder Gruppenziel.";
  }
  return null;
}

export interface CampaignPageProps {
  readonly fetchImpl?: FetchLike;
}

export function CampaignPage({ fetchImpl }: CampaignPageProps = {}) {
  const { invalidateSession } = useAdminSession();

  const client = useMemo(
    () =>
      createCampaignClient({
        fetchImpl,
        onUnauthorized: invalidateSession,
      }),
    [fetchImpl, invalidateSession],
  );

  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[] | null>(null);
  const [media, setMedia] = useState<MediaOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [extraTaxi, setExtraTaxi] = useState<string[]>([]);
  const [extraGroup, setExtraGroup] = useState<string[]>([]);
  const [newTaxi, setNewTaxi] = useState("");
  const [newGroup, setNewGroup] = useState("");

  const aliveRef = useRef(true);
  const loadSeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  const busyRef = useRef<string | null>(null);

  const loadAll = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [loadedCampaigns, loadedCustomers, loadedMedia] = await Promise.all([
        client.listCampaigns(),
        client.listCustomers(),
        client.listMedia(),
      ]);
      if (!aliveRef.current || seq !== loadSeqRef.current) {
        return false;
      }
      setCampaigns(loadedCampaigns);
      setCustomers(loadedCustomers);
      setMedia(loadedMedia);
      return true;
    } catch (error) {
      if (!aliveRef.current || seq !== loadSeqRef.current) {
        return false;
      }
      if (!isUnauthorizedError(error)) {
        setLoadError(messageFor(error));
      }
      return false;
    } finally {
      if (aliveRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    aliveRef.current = true;
    void loadAll();
    return () => {
      aliveRef.current = false;
      loadSeqRef.current += 1;
      detailSeqRef.current += 1;
    };
  }, [loadAll]);

  function applyCampaign(updated: Campaign): void {
    setCampaigns((current) => {
      if (current === null) {
        return [updated];
      }
      return current.map((item) =>
        item.id === updated.id ? updated : item,
      );
    });
  }

  function openCreate(): void {
    detailSeqRef.current += 1;
    setEditing({ campaignId: null });
    setForm(emptyForm());
    setFormLoading(false);
    setFormError(null);
    setActionError(null);
    setConflict(null);
    setNotice(null);
    setConfirm(null);
    setExtraTaxi([]);
    setExtraGroup([]);
    setNewTaxi("");
    setNewGroup("");
  }

  function openEdit(campaign: Campaign): void {
    const seq = ++detailSeqRef.current;
    setEditing({ campaignId: campaign.id });
    setForm(null);
    setFormLoading(true);
    setFormError(null);
    setActionError(null);
    setConflict(null);
    setNotice(null);
    setConfirm(null);
    setNewTaxi("");
    setNewGroup("");

    void (async () => {
      try {
        const detail = await client.getCampaign(campaign.id);
        if (!aliveRef.current || seq !== detailSeqRef.current) {
          return;
        }
        setForm(formFrom(detail));
        applyCampaign(detail);
      } catch (error) {
        if (!aliveRef.current || seq !== detailSeqRef.current) {
          return;
        }
        if (isUnauthorizedError(error)) {
          return;
        }
        setActionError(messageFor(error));
        setEditing(null);
      } finally {
        if (aliveRef.current && seq === detailSeqRef.current) {
          setFormLoading(false);
        }
      }
    })();
  }

  function closeEditor(): void {
    detailSeqRef.current += 1;
    setEditing(null);
    setForm(null);
    setFormLoading(false);
    setFormError(null);
  }

  async function handleConflict(error: unknown): Promise<void> {
    setEditing(null);
    setForm(null);
    setFormLoading(false);
    setFormError(null);
    setConfirm(null);
    const reloaded = await loadAll();
    if (!aliveRef.current) {
      return;
    }
    if (reloaded) {
      setConflict(CONFLICT_MESSAGE);
      setActionError(null);
    } else {
      setActionError(messageFor(error));
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busyRef.current !== null || editing === null || form === null) {
      return;
    }
    const targetId = editing.campaignId;
    const current =
      targetId === null
        ? null
        : (campaigns ?? []).find((item) => item.id === targetId) ?? null;
    if (targetId !== null && current === null) {
      setFormError("Die Kampagne ist nicht mehr in der Liste. Bitte neu laden.");
      return;
    }
    const invalid = validateForm(form, current?.status === "active");
    if (invalid !== null) {
      setFormError(invalid);
      return;
    }

    busyRef.current = "save";
    setBusy("save");
    setFormError(null);
    setActionError(null);
    setConflict(null);
    setNotice(null);

    try {
      if (targetId === null) {
        const created = await client.createCampaign({
          customerId: form.customerId.trim(),
          mediaId: form.mediaId.trim(),
          startAt: form.startAt.trim(),
          endAt: form.endAt.trim(),
          taxiIds: [...form.taxiIds],
          groupIds: [...form.groupIds],
        });
        if (!aliveRef.current) {
          return;
        }
        setCampaigns((previous) =>
          previous === null ? [created] : [...previous, created],
        );
        setNotice("Kampagne angelegt.");
        setEditing(null);
        setForm(null);
        return;
      }

      const updated = await client.updateCampaign(targetId, {
        mediaId: form.mediaId.trim(),
        startAt: form.startAt.trim(),
        endAt: form.endAt.trim(),
        taxiIds: [...form.taxiIds],
        groupIds: [...form.groupIds],
        revision: current === null ? 1 : current.revision,
      });
      if (!aliveRef.current) {
        return;
      }
      applyCampaign(updated);
      setForm(formFrom(updated));
      setNotice("Kampagne gespeichert.");
    } catch (error) {
      if (!aliveRef.current) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (
        isAdminApiError(error) &&
        (error.status === 400 || error.status === 409)
      ) {
        await handleConflict(error);
        return;
      }
      setFormError(messageFor(error));
    } finally {
      if (busyRef.current === "save") {
        busyRef.current = null;
        if (aliveRef.current) {
          setBusy(null);
        }
      }
    }
  }

  async function runPatch(
    campaign: Campaign,
    patch: {
      readonly status?: CampaignStatus;
      readonly archived?: boolean;
    },
    successMessage: string,
  ): Promise<void> {
    if (busyRef.current !== null) {
      return;
    }
    busyRef.current = "action:" + campaign.id;
    setBusy("action:" + campaign.id);
    setActionError(null);
    setConflict(null);
    setNotice(null);
    setConfirm(null);

    try {
      const updated = await client.updateCampaign(campaign.id, {
        ...patch,
        revision: campaign.revision,
      });
      if (!aliveRef.current) {
        return;
      }
      applyCampaign(updated);
      if (editing?.campaignId === updated.id) {
        setForm(formFrom(updated));
      }
      setNotice(successMessage);
    } catch (error) {
      if (!aliveRef.current) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (
        isAdminApiError(error) &&
        (error.status === 400 || error.status === 409)
      ) {
        await handleConflict(error);
        return;
      }
      setActionError(messageFor(error));
    } finally {
      if (busyRef.current === "action:" + campaign.id) {
        busyRef.current = null;
        if (aliveRef.current) {
          setBusy(null);
        }
      }
    }
  }

  function addTaxi(): void {
    const value = newTaxi.trim();
    if (value === "" || Array.from(value).length > MAX_TARGET_LENGTH) {
      setFormError("Taxi-Ziel muss 1 bis 128 Zeichen lang sein.");
      return;
    }
    setExtraTaxi((current) => unique([...current, value]));
    setForm((current) =>
      current === null
        ? current
        : { ...current, taxiIds: unique([...current.taxiIds, value]) },
    );
    setNewTaxi("");
    setFormError(null);
  }

  function addGroup(): void {
    const value = newGroup.trim();
    if (value === "" || Array.from(value).length > MAX_TARGET_LENGTH) {
      setFormError("Gruppen-Ziel muss 1 bis 128 Zeichen lang sein.");
      return;
    }
    setExtraGroup((current) => unique([...current, value]));
    setForm((current) =>
      current === null
        ? current
        : { ...current, groupIds: unique([...current.groupIds, value]) },
    );
    setNewGroup("");
    setFormError(null);
  }

  function onTaxiSelection(event: ChangeEvent<HTMLSelectElement>): void {
    const values = Array.from(event.target.selectedOptions, (option) => option.value);
    setForm((current) =>
      current === null ? current : { ...current, taxiIds: values },
    );
  }

  function onGroupSelection(event: ChangeEvent<HTMLSelectElement>): void {
    const values = Array.from(event.target.selectedOptions, (option) => option.value);
    setForm((current) =>
      current === null ? current : { ...current, groupIds: values },
    );
  }

  const customerName = (id: string): string =>
    (customers ?? []).find((item) => item.id === id)?.name ?? id;
  const mediaName = (id: string): string =>
    (media ?? []).find((item) => item.id === id)?.name ?? id;

  const taxiOptions = unique([
    ...(campaigns ?? []).flatMap((item) => item.taxiIds),
    ...extraTaxi,
    ...(form?.taxiIds ?? []),
  ]);
  const groupOptions = unique([
    ...(campaigns ?? []).flatMap((item) => item.groupIds),
    ...extraGroup,
    ...(form?.groupIds ?? []),
  ]);

  const selectedMedia =
    form === null
      ? null
      : (media ?? []).find((item) => item.id === form.mediaId) ?? null;
  const selectedCampaign =
    editing?.campaignId === null || editing === null
      ? null
      : (campaigns ?? []).find((item) => item.id === editing.campaignId) ?? null;
  const isBusy = busy !== null;
  const formActive = selectedCampaign?.status === "active";

  return (
    <section aria-label="Kampagnen">
      <h2>Kampagnen</h2>
      <p>
        Zustände: Entwurf, Aktiv, Pausiert, Beendet. Die Archivierung wird
        getrennt vom Zustand geführt.
      </p>

      <div>
        <button type="button" onClick={openCreate} disabled={isBusy}>
          Neue Kampagne
        </button>
        <button
          type="button"
          onClick={() => void loadAll()}
          disabled={loading || isBusy}
        >
          Neu laden
        </button>
      </div>

      {loading && campaigns === null ? (
        <p>Kampagnen werden geladen …</p>
      ) : null}

      {loadError !== null ? (
        <div role="alert">
          <p>{LOAD_FAILED_MESSAGE}</p>
          <p>{loadError}</p>
        </div>
      ) : null}

      {conflict !== null ? <p role="alert">{conflict}</p> : null}
      {actionError !== null ? <p role="alert">{actionError}</p> : null}
      {notice !== null ? <p role="status">{notice}</p> : null}

      {editing !== null ? (
        <section aria-label={editing.campaignId === null ? "Neue Kampagne" : "Kampagne bearbeiten"}>
          <h3>
            {editing.campaignId === null
              ? "Neue Kampagne"
              : "Kampagne bearbeiten"}
          </h3>

          {formLoading || form === null ? (
            <p>Kampagne wird geladen …</p>
          ) : (
            <form onSubmit={(event) => void handleSave(event)} noValidate>
              <div>
                <label htmlFor="campaign-customer">Kunde</label>
                <select
                  id="campaign-customer"
                  value={form.customerId}
                  onChange={(event) =>
                    setForm({ ...form, customerId: event.target.value })
                  }
                  disabled={isBusy}
                >
                  <option value="">Bitte wählen</option>
                  {(customers ?? []).map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="campaign-media">Medium</label>
                <select
                  id="campaign-media"
                  value={form.mediaId}
                  onChange={(event) =>
                    setForm({ ...form, mediaId: event.target.value })
                  }
                  disabled={isBusy}
                >
                  <option value="">Bitte wählen</option>
                  {(media ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="campaign-start">
                  Laufzeitbeginn (UTC, YYYY-MM-DDTHH:mm:ss.SSSZ)
                </label>
                <input
                  id="campaign-start"
                  type="text"
                  value={form.startAt}
                  onChange={(event) =>
                    setForm({ ...form, startAt: event.target.value })
                  }
                  disabled={isBusy}
                />
              </div>

              <div>
                <label htmlFor="campaign-end">
                  Laufzeitende (UTC, YYYY-MM-DDTHH:mm:ss.SSSZ)
                </label>
                <input
                  id="campaign-end"
                  type="text"
                  value={form.endAt}
                  onChange={(event) =>
                    setForm({ ...form, endAt: event.target.value })
                  }
                  disabled={isBusy}
                />
              </div>

              <fieldset>
                <legend>Taxiziele</legend>
                <p>
                  Ein Taxi umfasst beide Tablets. Es gibt keine
                  Tablet-Einzelbuchung.
                </p>
                <label htmlFor="campaign-taxis">Taxiziele (Mehrfachauswahl)</label>
                <select
                  id="campaign-taxis"
                  aria-label="Taxiziele"
                  multiple
                  value={[...form.taxiIds]}
                  onChange={onTaxiSelection}
                  disabled={isBusy}
                >
                  {taxiOptions.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <label htmlFor="campaign-new-taxi">Weiteres Taxi-Ziel</label>
                <input
                  id="campaign-new-taxi"
                  type="text"
                  value={newTaxi}
                  maxLength={MAX_TARGET_LENGTH}
                  onChange={(event) => setNewTaxi(event.target.value)}
                  disabled={isBusy}
                />
                <button type="button" onClick={addTaxi} disabled={isBusy}>
                  Taxi-Ziel hinzufügen
                </button>
              </fieldset>

              <fieldset>
                <legend>Gruppenziele</legend>
                <label htmlFor="campaign-groups">Gruppenziele (Mehrfachauswahl)</label>
                <select
                  id="campaign-groups"
                  aria-label="Gruppenziele"
                  multiple
                  value={[...form.groupIds]}
                  onChange={onGroupSelection}
                  disabled={isBusy}
                >
                  {groupOptions.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
                <label htmlFor="campaign-new-group">Weiteres Gruppen-Ziel</label>
                <input
                  id="campaign-new-group"
                  type="text"
                  value={newGroup}
                  maxLength={MAX_TARGET_LENGTH}
                  onChange={(event) => setNewGroup(event.target.value)}
                  disabled={isBusy}
                />
                <button type="button" onClick={addGroup} disabled={isBusy}>
                  Gruppen-Ziel hinzufügen
                </button>
              </fieldset>

              {form.mediaId !== "" ? (
                <MediaPreview
                  key={form.mediaId}
                  media={selectedMedia}
                />
              ) : (
                <fieldset>
                  <legend>Medienvorschau (lokal)</legend>
                  <p>Lokale Originaldatei für Vorschau auswählen</p>
                  <p>Zuerst ein Medium wählen.</p>
                </fieldset>
              )}

              {formError !== null ? <p role="alert">{formError}</p> : null}

              <div>
                <button type="submit" disabled={isBusy || formLoading}>
                  {editing.campaignId === null
                    ? "Kampagne anlegen"
                    : "Änderungen speichern"}
                </button>
                <button
                  type="button"
                  onClick={closeEditor}
                  disabled={isBusy}
                >
                  Abbrechen
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      {campaigns !== null && campaigns.length === 0 && !loading ? (
        <p>Keine Kampagnen vorhanden.</p>
      ) : null}

      {campaigns !== null && campaigns.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Kunde</th>
              <th scope="col">Medium</th>
              <th scope="col">Laufzeit</th>
              <th scope="col">Status</th>
              <th scope="col">Archiv</th>
              <th scope="col">Ziele</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => {
              const confirming =
                confirm !== null && confirm.campaignId === campaign.id;
              return (
                <tr key={campaign.id} data-status={campaign.status}>
                  <td>{customerName(campaign.customerId)}</td>
                  <td>{mediaName(campaign.mediaId)}</td>
                  <td>
                    <time dateTime={campaign.startAt}>{campaign.startAt}</time>
                    {" – "}
                    <time dateTime={campaign.endAt}>{campaign.endAt}</time>
                  </td>
                  <td>{STATUS_LABELS[campaign.status]}</td>
                  <td>{campaign.archived ? "Archiviert" : "—"}</td>
                  <td>
                    <div>Taxis: {campaign.taxiIds.length > 0 ? campaign.taxiIds.join(", ") : "—"}</div>
                    <div>Gruppen: {campaign.groupIds.length > 0 ? campaign.groupIds.join(", ") : "—"}</div>
                  </td>
                  <td>
                    {confirming && confirm !== null ? (
                      confirm.action === "finish" ? (
                        <span>
                          <span>Wirklich beenden?</span>
                          <button
                            type="button"
                            onClick={() =>
                              void runPatch(
                                campaign,
                                { status: "finished" },
                                "Kampagne beendet.",
                              )
                            }
                            disabled={isBusy}
                          >
                            Bestätigen
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirm(null)}
                            disabled={isBusy}
                          >
                            Abbrechen
                          </button>
                        </span>
                      ) : (
                        <span>
                          <span>Wirklich archivieren?</span>
                          <button
                            type="button"
                            onClick={() =>
                              void runPatch(
                                campaign,
                                { archived: true },
                                "Kampagne archiviert.",
                              )
                            }
                            disabled={isBusy}
                          >
                            Bestätigen
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirm(null)}
                            disabled={isBusy}
                          >
                            Abbrechen
                          </button>
                        </span>
                      )
                    ) : campaign.archived ? (
                      <span>Schreibgeschützt</span>
                    ) : (
                      <span>
                        <button
                          type="button"
                          onClick={() => openEdit(campaign)}
                          disabled={isBusy}
                        >
                          Bearbeiten
                        </button>
                        {campaign.status === "draft" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void runPatch(
                                campaign,
                                { status: "active" },
                                "Kampagne aktiviert.",
                              )
                            }
                            disabled={isBusy}
                          >
                            Aktivieren
                          </button>
                        ) : null}
                        {campaign.status === "paused" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void runPatch(
                                campaign,
                                { status: "active" },
                                "Kampagne fortgesetzt.",
                              )
                            }
                            disabled={isBusy}
                          >
                            Fortsetzen
                          </button>
                        ) : null}
                        {campaign.status === "active" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void runPatch(
                                campaign,
                                { status: "paused" },
                                "Kampagne pausiert.",
                              )
                            }
                            disabled={isBusy}
                          >
                            Pausieren
                          </button>
                        ) : null}
                        {campaign.status === "draft" ||
                        campaign.status === "active" ||
                        campaign.status === "paused" ? (
                          <button
                            type="button"
                            onClick={() =>
                              setConfirm({
                                campaignId: campaign.id,
                                action: "finish",
                              })
                            }
                            disabled={isBusy}
                          >
                            Beenden
                          </button>
                        ) : null}
                        {campaign.status === "draft" ||
                        campaign.status === "finished" ? (
                          <button
                            type="button"
                            onClick={() =>
                              setConfirm({
                                campaignId: campaign.id,
                                action: "archive",
                              })
                            }
                            disabled={isBusy}
                          >
                            Archivieren
                          </button>
                        ) : null}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export default CampaignPage;

