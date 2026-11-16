import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent } from "react";

import type { FetchLike } from "../admin/adminApi";
import { isAdminApiError, isUnauthorizedError } from "../admin/adminApi";
import { useAdminSession } from "../admin/AdminShell";
import type {
  FleetClient,
  FleetGroup,
  FleetInventoryItem,
  FleetTablet,
  FleetTaxi,
  FleetTransport,
} from "./fleetApi";
import {
  CONFLICT_MESSAGE,
  createFleetClient,
  isFleetConflict,
  isUnclearWriteOutcome,
} from "./fleetApi";

const MISSING = "Nicht erfasst";
const NOT_ASSIGNED = "Nicht belegt";
const UNEXPECTED_MESSAGE = "Ein unerwarteter Fehler ist aufgetreten.";
const UNCLEAR_WRITE_MESSAGE =
  "Der Ausgang der Änderung ist unklar. Es wird nicht automatisch wiederholt. Bitte nur die aktuellen Daten neu laden.";
const REQUIRED_TAXI_MESSAGE = "Kennung und Anzeigename sind erforderlich.";
const GROUP_NAME_REQUIRED = "Bitte einen Gruppennamen eingeben.";
const PAIR_REQUIRED_MESSAGE =
  "Bitte zwei verschiedene, verfügbare Tablets auswählen.";
const PAIR_ACTIVE_TAXI_MESSAGE =
  "Einem aktiven Taxi kann kein neues Tablet-Paar zugeordnet werden. Bitte das Taxi zuerst deaktivieren.";
const ACTIVATION_PAIR_MESSAGE =
  "Eine Aktivierung ist nur mit einem vollständigen Paar aus zwei verschiedenen Tablets möglich.";
const INVENTORY_SAVED = "Inventardaten gespeichert.";
const TAXI_SAVED = "Taxi gespeichert.";
const GROUP_SAVED = "Gruppe gespeichert.";
const TABLET_DEACTIVATION_CONFIRMED = "Tablet-Deaktivierung bestätigt.";

/**
 * Clientseitige Obergrenzen fuer die drei einfachen Inventarfelder. Der
 * Server bleibt massgeblich; die Grenzen verhindern lediglich, dass
 * offensichtlich zu lange Eingaben unnoetig gesendet werden.
 */
export const INVENTORY_LIMITS = {
  serialNumber: 128,
  deviceType: 64,
  replacementNote: 500,
} as const;

export interface FleetPageProps {
  /** Injizierbarer Transport fuer Tests; niemals eine echte Netzverbindung. */
  readonly transport?: FleetTransport;
  /** Injizierbares fetch, falls kein Transport angegeben ist. */
  readonly fetchImpl?: FetchLike;
}

interface TaxiFormState {
  readonly mode: "create" | "edit";
  readonly id: string;
  readonly displayName: string;
  readonly groupIds: readonly string[];
  readonly revision: number | null;
  readonly active: boolean;
}

function messageFor(error: unknown): string {
  return isAdminApiError(error) ? error.message : UNEXPECTED_MESSAGE;
}

function displayOrMissing(value: string | null): string {
  if (value === null || value.trim() === "") {
    return MISSING;
  }
  return value;
}

function upsertBy<T>(
  items: readonly T[] | null,
  next: T,
  keyOf: (item: T) => string,
): T[] {
  const list = items === null ? [] : [...items];
  const key = keyOf(next);
  const index = list.findIndex((item) => keyOf(item) === key);
  if (index === -1) {
    list.push(next);
  } else {
    list[index] = next;
  }
  return list;
}

function fromTaxi(taxi: FleetTaxi): TaxiFormState {
  return {
    mode: "edit",
    id: taxi.id,
    displayName: taxi.displayName,
    groupIds: [...taxi.groupIds],
    revision: taxi.revision,
    active: taxi.active,
  };
}

function hasCompletePair(
  first: string | null,
  second: string | null,
): boolean {
  return first !== null && second !== null && first !== second;
}

/**
 * CX-037: Taxi-, Gruppen- und Inventarseite. Saemtliche Schreibwege senden
 * Revisionen, warten auf die bestaetigte Serverantwort und wiederholen nie
 * automatisch. Die Sitzung, die 401-Invalidierung und die Fehlerbehandlung
 * kommen aus der vorhandenen AdminShell.
 */
export function FleetPage({ transport, fetchImpl }: FleetPageProps) {
  const { invalidateSession } = useAdminSession();

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const loadSeqRef = useRef(0);
  /**
   * Nach einem unklaren Schreibausgang bleibt jede Schreibaktion gesperrt,
   * bis ein danach gestarteter Ladevorgang erfolgreich bestaetigt wurde.
   * Die Refs spiegeln den Zustand synchron, damit auch zwei unmittelbar
   * aufeinanderfolgende Klicks nicht an einer veralteten Renderphase
   * vorbeikommen.
   */
  const unclearWriteRef = useRef(false);
  const reconcileOnReloadRef = useRef(false);
  const unlockMinSeqRef = useRef(0);

  const [taxis, setTaxis] = useState<FleetTaxi[] | null>(null);
  const [groups, setGroups] = useState<FleetGroup[] | null>(null);
  const [tablets, setTablets] = useState<FleetTablet[] | null>(null);
  const [inventory, setInventory] = useState<FleetInventoryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [unclearWrite, setUnclearWrite] = useState(false);

  const [taxiForm, setTaxiForm] = useState<TaxiFormState | null>(null);
  const [pairFirst, setPairFirst] = useState<string | null>(null);
  const [pairSecond, setPairSecond] = useState<string | null>(null);
  const [taxiSaving, setTaxiSaving] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [taxiActivating, setTaxiActivating] = useState(false);
  const taxiSavingRef = useRef(false);
  const pairingRef = useRef(false);
  const taxiActivatingRef = useRef(false);

  const [newGroupName, setNewGroupName] = useState("");
  const [groupBusy, setGroupBusy] = useState(false);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /**
   * Ein Revisionskonflikt bleibt sichtbar, bis die Daten ausdruecklich neu
   * geladen wurden. Die Eingabe bleibt dabei erhalten; ohne dieses
   * Nachladen ist ein erneutes Absenden gesperrt.
   */
  const [renameConflict, setRenameConflict] = useState(false);
  const groupBusyRef = useRef(false);

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const taxiFormRef = useRef<TaxiFormState | null>(null);
  const selectedDeviceIdRef = useRef<string | null>(null);
  const inventoryRequestSeqRef = useRef(0);
  const [inventorySerial, setInventorySerial] = useState("");
  const [inventoryType, setInventoryType] = useState("");
  const [inventoryNote, setInventoryNote] = useState("");
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmDeactivateId, setConfirmDeactivateId] = useState<string | null>(
    null,
  );
  const inventoryBusyRef = useRef(false);
  const deactivatingRef = useRef(false);

  useEffect(() => {
    taxiFormRef.current = taxiForm;
  }, [taxiForm]);

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

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

  const isAlive = useCallback(
    (generation: number) =>
      mountedRef.current && generation === generationRef.current,
    [],
  );

  /**
   * Ein unklarer Ausgang sperrt saemtliche Schreibwege. Nur ein Ladevorgang,
   * der nach dieser Sperre gestartet wurde, darf sie wieder aufheben.
   */
  function lockUnclearWrite(): void {
    unclearWriteRef.current = true;
    reconcileOnReloadRef.current = true;
    unlockMinSeqRef.current = loadSeqRef.current + 1;
    setUnclearWrite(true);
    setActionError(UNCLEAR_WRITE_MESSAGE);
  }

  /**
   * Nach bestaetigtem Nachladen werden bearbeitete Formulare aus den
   * bestaetigten Daten neu befuellt. Ein Entwurf ohne Serverbezug
   * (Neuanlage) wird geschlossen, weil sein Ausgang ungeklaert ist.
   */
  function reconcileFromConfirmed(
    nextTaxis: readonly FleetTaxi[],
    nextInventory: readonly FleetInventoryItem[],
  ): void {
    const form = taxiFormRef.current;
    if (form !== null) {
      const confirmed =
        form.mode === "edit"
          ? nextTaxis.find((item) => item.id === form.id) ?? null
          : null;
      if (confirmed === null) {
        setTaxiForm(null);
        setPairFirst(null);
        setPairSecond(null);
      } else {
        setTaxiForm(fromTaxi(confirmed));
        setPairFirst(confirmed.tabletIds[0]);
        setPairSecond(confirmed.tabletIds[1]);
      }
    }
    const deviceId = selectedDeviceIdRef.current;
    if (deviceId !== null) {
      const item =
        nextInventory.find((entry) => entry.deviceId === deviceId) ?? null;
      if (item === null) {
        closeInventoryEdit();
      } else {
        setInventorySerial(item.serialNumber ?? "");
        setInventoryType(item.deviceType ?? "");
        setInventoryNote(item.replacementNote ?? "");
      }
    }
  }

  const loadAll = useCallback(
    async (generation: number): Promise<boolean> => {
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setLoadError(null);
      try {
        const [nextTaxis, nextGroups, nextTablets, nextInventory] =
          await Promise.all([
            client.listTaxis(),
            client.listGroups(),
            client.listTablets(),
            client.listInventory(),
          ]);
        if (!isAlive(generation) || seq !== loadSeqRef.current) {
          return false;
        }
        setTaxis(nextTaxis);
        setGroups(nextGroups);
        setTablets(nextTablets);
        setInventory(nextInventory);
        if (seq >= unlockMinSeqRef.current) {
          const wasLocked = unclearWriteRef.current;
          unclearWriteRef.current = false;
          setUnclearWrite(false);
          if (wasLocked && reconcileOnReloadRef.current) {
            reconcileOnReloadRef.current = false;
            reconcileFromConfirmed(nextTaxis, nextInventory);
            setActionError(null);
          }
        }
        return true;
      } catch (error) {
        if (!isAlive(generation) || seq !== loadSeqRef.current) {
          return false;
        }
        // 401 laeuft ausschliesslich ueber die zentrale AdminShell.
        if (isUnauthorizedError(error)) {
          return false;
        }
        setLoadError(messageFor(error));
        return false;
      } finally {
        if (isAlive(generation) && seq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [client, isAlive],
  );

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current;
    void loadAll(generation);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      loadSeqRef.current += 1;
    };
  }, [loadAll]);

  function startCreateTaxi(): void {
    if (unclearWriteRef.current) {
      return;
    }
    setTaxiForm({
      mode: "create",
      id: "",
      displayName: "",
      groupIds: [],
      revision: null,
      active: false,
    });
    setPairFirst(null);
    setPairSecond(null);
    setActionError(null);
    setNotice(null);
  }

  function startEditTaxi(taxi: FleetTaxi): void {
    if (unclearWriteRef.current) {
      return;
    }
    setTaxiForm(fromTaxi(taxi));
    setPairFirst(taxi.tabletIds[0]);
    setPairSecond(taxi.tabletIds[1]);
    setActionError(null);
    setNotice(null);
  }

  function toggleGroup(groupId: string): void {
    setTaxiForm((current) => {
      if (current === null) {
        return current;
      }
      const selected = current.groupIds.includes(groupId);
      return {
        ...current,
        groupIds: selected
          ? current.groupIds.filter((id) => id !== groupId)
          : [...current.groupIds, groupId],
      };
    });
  }

  async function handleTaxiSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = taxiForm;
    if (
      form === null ||
      taxiSavingRef.current ||
      unclearWriteRef.current
    ) {
      return;
    }
    const generation = generationRef.current;
    const id = form.id.trim();
    const displayName = form.displayName.trim();
    if (id === "" || displayName === "") {
      setActionError(REQUIRED_TAXI_MESSAGE);
      return;
    }

    taxiSavingRef.current = true;
    setTaxiSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const saved =
        form.mode === "create"
          ? await client.createTaxi({
              id,
              displayName,
              groupIds: form.groupIds,
            })
          : await client.updateTaxi(id, {
              displayName,
              groupIds: form.groupIds,
              revision: form.revision ?? 0,
            });
      if (!isAlive(generation)) {
        return;
      }
      setTaxis((current) => upsertBy(current, saved, (item) => item.id));
      setTaxiForm(fromTaxi(saved));
      setPairFirst(saved.tabletIds[0]);
      setPairSecond(saved.tabletIds[1]);
      setNotice(TAXI_SAVED);
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        setActionError(CONFLICT_MESSAGE);
        setTaxiForm(null);
        await loadAll(generation);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      taxiSavingRef.current = false;
      if (isAlive(generation)) {
        setTaxiSaving(false);
      }
    }
  }

  async function handlePairSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = taxiForm;
    if (
      form === null ||
      form.mode !== "edit" ||
      form.revision === null ||
      pairingRef.current ||
      unclearWriteRef.current
    ) {
      return;
    }
    if (form.active) {
      setActionError(PAIR_ACTIVE_TAXI_MESSAGE);
      return;
    }
    const availableIds = new Set(
      (tablets ?? []).filter((item) => item.available).map((item) => item.id),
    );
    if (
      !hasCompletePair(pairFirst, pairSecond) ||
      pairFirst === null ||
      pairSecond === null ||
      !availableIds.has(pairFirst) ||
      !availableIds.has(pairSecond)
    ) {
      setActionError(PAIR_REQUIRED_MESSAGE);
      return;
    }

    const generation = generationRef.current;
    pairingRef.current = true;
    setPairing(true);
    setActionError(null);
    setNotice(null);
    try {
      const saved = await client.assignTablets(
        form.id,
        [pairFirst, pairSecond],
        form.revision,
      );
      if (!isAlive(generation)) {
        return;
      }
      setTaxis((current) => upsertBy(current, saved, (item) => item.id));
      setTaxiForm(fromTaxi(saved));
      setPairFirst(saved.tabletIds[0]);
      setPairSecond(saved.tabletIds[1]);
      setNotice("Tablet-Paar gespeichert.");
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        setActionError(CONFLICT_MESSAGE);
        setTaxiForm(null);
        await loadAll(generation);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      pairingRef.current = false;
      if (isAlive(generation)) {
        setPairing(false);
      }
    }
  }

  async function handleActivation(): Promise<void> {
    const form = taxiForm;
    if (
      form === null ||
      form.mode !== "edit" ||
      form.revision === null ||
      taxiActivatingRef.current ||
      unclearWriteRef.current
    ) {
      return;
    }
    const nextActive = !form.active;
    // Massgeblich ist ausschliesslich das zuletzt serverbestaetigte Paar,
    // nicht die noch ungespeicherte Auswahl der Formularfelder.
    const confirmed =
      (taxis ?? []).find((item) => item.id === form.id) ?? null;
    if (
      nextActive &&
      (confirmed === null ||
        !hasCompletePair(confirmed.tabletIds[0], confirmed.tabletIds[1]))
    ) {
      setActionError(ACTIVATION_PAIR_MESSAGE);
      return;
    }

    const generation = generationRef.current;
    taxiActivatingRef.current = true;
    setTaxiActivating(true);
    setActionError(null);
    setNotice(null);
    try {
      const saved = await client.setTaxiActive(
        form.id,
        nextActive,
        form.revision,
      );
      if (!isAlive(generation)) {
        return;
      }
      setTaxis((current) => upsertBy(current, saved, (item) => item.id));
      setTaxiForm(fromTaxi(saved));
      setPairFirst(saved.tabletIds[0]);
      setPairSecond(saved.tabletIds[1]);
      setNotice(
        nextActive ? "Taxi aktiviert." : "Taxi deaktiviert.",
      );
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        setActionError(CONFLICT_MESSAGE);
        setTaxiForm(null);
        await loadAll(generation);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      taxiActivatingRef.current = false;
      if (isAlive(generation)) {
        setTaxiActivating(false);
      }
    }
  }

  async function handleCreateGroup(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (groupBusyRef.current || unclearWriteRef.current) {
      return;
    }
    const name = newGroupName.trim();
    if (name === "") {
      setActionError(GROUP_NAME_REQUIRED);
      return;
    }
    const generation = generationRef.current;
    groupBusyRef.current = true;
    setGroupBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const created = await client.createGroup(name);
      if (!isAlive(generation)) {
        return;
      }
      setGroups((current) => upsertBy(current, created, (item) => item.id));
      setNewGroupName("");
      setNotice(GROUP_SAVED);
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        setActionError(CONFLICT_MESSAGE);
        await loadAll(generation);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      groupBusyRef.current = false;
      if (isAlive(generation)) {
        setGroupBusy(false);
      }
    }
  }

  async function handleRenameGroup(
    event: FormEvent<HTMLFormElement>,
    group: FleetGroup,
  ): Promise<void> {
    event.preventDefault();
    if (groupBusyRef.current || unclearWriteRef.current || renameConflict) {
      return;
    }
    const name = renameDraft.trim();
    if (name === "") {
      setActionError(GROUP_NAME_REQUIRED);
      return;
    }
    const generation = generationRef.current;
    groupBusyRef.current = true;
    setGroupBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const saved = await client.renameGroup(
        group.id,
        name,
        group.revision,
      );
      if (!isAlive(generation)) {
        return;
      }
      setGroups((current) => upsertBy(current, saved, (item) => item.id));
      setRenamingGroupId(null);
      setRenameDraft("");
      setRenameConflict(false);
      setNotice(GROUP_SAVED);
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        // Eingabe und Bearbeitungszustand bleiben erhalten. Es wird weder
        // automatisch nachgeladen noch mit einer neuen Revision geschrieben;
        // das Nachladen bietet die Ansicht ausdruecklich an.
        setRenameConflict(true);
        setActionError(CONFLICT_MESSAGE);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      groupBusyRef.current = false;
      if (isAlive(generation)) {
        setGroupBusy(false);
      }
    }
  }

  function reloadGroupsAfterConflict(): void {
    setRenameConflict(false);
    setActionError(null);
    const generation = generationRef.current;
    void loadAll(generation);
  }

  function startInventoryEdit(item: FleetInventoryItem): void {
    // Waehrend eines laufenden Inventarschreibvorgangs und solange ein
    // Ausgang unklar ist, darf das bearbeitete Geraet nicht wechseln.
    if (inventoryBusyRef.current || unclearWriteRef.current) {
      return;
    }
    setSelectedDeviceId(item.deviceId);
    setInventorySerial(item.serialNumber ?? "");
    setInventoryType(item.deviceType ?? "");
    setInventoryNote(item.replacementNote ?? "");
    setActionError(null);
    setNotice(null);
    setConfirmDeactivateId(null);
  }

  function closeInventoryEdit(): void {
    setSelectedDeviceId(null);
    setInventorySerial("");
    setInventoryType("");
    setInventoryNote("");
    setConfirmDeactivateId(null);
  }

  function inventoryLengthError(): string | null {
    if (inventorySerial.length > INVENTORY_LIMITS.serialNumber) {
      return (
        "Die Seriennummer ist zu lang (höchstens " +
        INVENTORY_LIMITS.serialNumber +
        " Zeichen)."
      );
    }
    if (inventoryType.length > INVENTORY_LIMITS.deviceType) {
      return (
        "Der Gerätetyp ist zu lang (höchstens " +
        INVENTORY_LIMITS.deviceType +
        " Zeichen)."
      );
    }
    if (inventoryNote.length > INVENTORY_LIMITS.replacementNote) {
      return (
        "Der Austauschvermerk ist zu lang (höchstens " +
        INVENTORY_LIMITS.replacementNote +
        " Zeichen)."
      );
    }
    return null;
  }

  async function handleInventorySave(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const item = (inventory ?? []).find(
      (entry) => entry.deviceId === selectedDeviceId,
    );
    if (
      item === undefined ||
      selectedDeviceId === null ||
      inventoryBusyRef.current ||
      unclearWriteRef.current
    ) {
      return;
    }
    const lengthError = inventoryLengthError();
    if (lengthError !== null) {
      setActionError(lengthError);
      return;
    }

    const generation = generationRef.current;
    const deviceId = selectedDeviceId;
    const requestSeq = ++inventoryRequestSeqRef.current;
    inventoryBusyRef.current = true;
    setInventoryBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const saved = await client.updateInventoryItem(deviceId, {
        serialNumber:
          inventorySerial.trim() === "" ? null : inventorySerial,
        deviceType: inventoryType.trim() === "" ? null : inventoryType,
        replacementNote:
          inventoryNote.trim() === "" ? null : inventoryNote,
        revision: item.revision,
      });
      // Die Antwort gilt nur fuer genau dieses Geraet und diesen
      // Schreibvorgang; ein inzwischen anderes Formular bleibt unberuehrt.
      if (
        !isAlive(generation) ||
        inventoryRequestSeqRef.current !== requestSeq ||
        selectedDeviceIdRef.current !== deviceId
      ) {
        return;
      }
      setInventory((current) =>
        upsertBy(current, saved, (entry) => entry.deviceId),
      );
      setInventorySerial(saved.serialNumber ?? "");
      setInventoryType(saved.deviceType ?? "");
      setInventoryNote(saved.replacementNote ?? "");
      setNotice(INVENTORY_SAVED);
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        setActionError(CONFLICT_MESSAGE);
        closeInventoryEdit();
        await loadAll(generation);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      inventoryBusyRef.current = false;
      if (isAlive(generation)) {
        setInventoryBusy(false);
      }
    }
  }

  async function setTabletActivation(
    item: FleetInventoryItem,
    active: boolean,
  ): Promise<void> {
    if (
      inventoryBusyRef.current ||
      deactivatingRef.current ||
      unclearWriteRef.current
    ) {
      return;
    }
    const generation = generationRef.current;
    if (active) {
      inventoryBusyRef.current = true;
      setInventoryBusy(true);
    } else {
      deactivatingRef.current = true;
      setDeactivating(true);
    }
    setActionError(null);
    setNotice(null);
    try {
      const saved = await client.updateInventoryItem(item.deviceId, {
        serialNumber: item.serialNumber,
        deviceType: item.deviceType,
        replacementNote: item.replacementNote,
        adminActive: active,
        revision: item.revision,
      });
      if (!isAlive(generation)) {
        return;
      }
      setInventory((current) =>
        upsertBy(current, saved, (entry) => entry.deviceId),
      );
      setConfirmDeactivateId(null);
      setNotice(
        active
          ? "Tablet aktiviert."
          : TABLET_DEACTIVATION_CONFIRMED,
      );
      // Nach einer bestaetigten Deaktivierung kann der Server das Taxi
      // mitdeaktiviert haben; deshalb werden die Listen nachgeladen.
      if (!active) {
        await loadAll(generation);
      }
    } catch (error) {
      if (!isAlive(generation)) {
        return;
      }
      if (isUnauthorizedError(error)) {
        return;
      }
      if (isFleetConflict(error)) {
        setActionError(CONFLICT_MESSAGE);
        setConfirmDeactivateId(null);
        await loadAll(generation);
        return;
      }
      if (isUnclearWriteOutcome(error)) {
        lockUnclearWrite();
        return;
      }
      setActionError(messageFor(error));
    } finally {
      if (active) {
        inventoryBusyRef.current = false;
        if (isAlive(generation)) {
          setInventoryBusy(false);
        }
      } else {
        deactivatingRef.current = false;
        if (isAlive(generation)) {
          setDeactivating(false);
        }
      }
    }
  }

  function refresh(): void {
    const generation = generationRef.current;
    // Waehrend einer offenen Unklarheit bleiben Meldung und Sperre stehen;
    // erst ein erfolgreich bestaetigter Ladevorgang hebt beides auf.
    if (!unclearWriteRef.current) {
      setActionError(null);
      setNotice(null);
    }
    void loadAll(generation);
  }

  const availableTablets = (tablets ?? []).filter((item) => item.available);
  const selectedInventory =
    selectedDeviceId === null
      ? null
      : (inventory ?? []).find(
          (item) => item.deviceId === selectedDeviceId,
        ) ?? null;
  const confirmedTaxi =
    taxiForm === null
      ? null
      : (taxis ?? []).find((item) => item.id === taxiForm.id) ?? null;
  const confirmedPairComplete =
    confirmedTaxi !== null &&
    hasCompletePair(confirmedTaxi.tabletIds[0], confirmedTaxi.tabletIds[1]);

  function groupNames(ids: readonly string[]): string {
    if (ids.length === 0) {
      return "Keine";
    }
    return ids
      .map(
        (id) =>
          (groups ?? []).find((group) => group.id === id)?.name ?? id,
      )
      .join(", ");
  }

  return (
    <div>
      <section aria-label="Taxis">
      <h2>Taxis</h2>

      <div>
        <button type="button" onClick={refresh} disabled={loading}>
          Aktualisieren
        </button>
        <button
          type="button"
          onClick={startCreateTaxi}
          disabled={unclearWrite}
        >
          Taxi anlegen
        </button>
      </div>

      {loading ? <p>Taxis werden geladen …</p> : null}
      {loadError !== null ? (
        <div role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={refresh}>
            Erneut laden
          </button>
        </div>
      ) : null}
      {actionError !== null ? <p role="alert">{actionError}</p> : null}
      {unclearWrite ? (
        <button type="button" onClick={refresh} disabled={loading}>
          Neu laden
        </button>
      ) : null}
      {notice !== null ? <p role="status">{notice}</p> : null}

      {taxis !== null && taxis.length === 0 ? (
        <p>Keine Taxis vorhanden.</p>
      ) : null}

      {taxis !== null && taxis.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Kennung</th>
              <th scope="col">Anzeigename</th>
              <th scope="col">Status</th>
              <th scope="col">Tablet 1</th>
              <th scope="col">Tablet 2</th>
              <th scope="col">Gruppen</th>
              <th scope="col">Aktion</th>
            </tr>
          </thead>
          <tbody>
            {taxis.map((taxi) => (
              <tr key={taxi.id}>
                <td>{taxi.id}</td>
                <td>{taxi.displayName}</td>
                <td>{taxi.active ? "Aktiv" : "Inaktiv"}</td>
                <td>{taxi.tabletIds[0] ?? NOT_ASSIGNED}</td>
                <td>{taxi.tabletIds[1] ?? NOT_ASSIGNED}</td>
                <td>{groupNames(taxi.groupIds)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => startEditTaxi(taxi)}
                    disabled={unclearWrite}
                  >
                    Bearbeiten
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {taxiForm !== null ? (
        <section aria-label="Taxiformular">
          <h3>
            {taxiForm.mode === "create" ? "Taxi anlegen" : "Taxi ändern"}
          </h3>
          <form onSubmit={(event) => void handleTaxiSubmit(event)} noValidate>
            <label htmlFor="taxi-id">Kennung</label>
            <input
              id="taxi-id"
              name="taxi-id"
              type="text"
              value={taxiForm.id}
              readOnly={taxiForm.mode === "edit"}
              disabled={taxiForm.mode === "edit" || taxiSaving}
              onChange={(event) =>
                setTaxiForm({
                  ...taxiForm,
                  id: event.target.value,
                })
              }
            />

            <label htmlFor="taxi-name">Anzeigename</label>
            <input
              id="taxi-name"
              name="taxi-name"
              type="text"
              value={taxiForm.displayName}
              disabled={taxiSaving}
              onChange={(event) =>
                setTaxiForm({
                  ...taxiForm,
                  displayName: event.target.value,
                })
              }
            />

            <fieldset>
              <legend>Gruppen</legend>
              {(groups ?? []).length === 0 ? (
                <p>Keine Gruppen vorhanden.</p>
              ) : (
                (groups ?? []).map((group) => (
                  <label key={group.id}>
                    <input
                      type="checkbox"
                      checked={taxiForm.groupIds.includes(group.id)}
                      disabled={taxiSaving}
                      onChange={() => toggleGroup(group.id)}
                    />
                    {group.name}
                  </label>
                ))
              )}
            </fieldset>

            <button
              type="submit"
              disabled={taxiSaving || unclearWrite}
            >
              Speichern
            </button>
            <button
              type="button"
              onClick={() => {
                setTaxiForm(null);
                setPairFirst(null);
                setPairSecond(null);
              }}
              disabled={taxiSaving}
            >
              Abbrechen
            </button>
          </form>

          {taxiForm.mode === "edit" ? (
            <section aria-label="Tablet-Paar">
              <h4>Tablet-Paar</h4>
              {taxiForm.active ? (
                <p>{PAIR_ACTIVE_TAXI_MESSAGE}</p>
              ) : null}
              <form onSubmit={(event) => void handlePairSubmit(event)}>
                <label htmlFor="tablet-1">Tablet 1</label>
                <select
                  id="tablet-1"
                  value={pairFirst ?? ""}
                  disabled={pairing || taxiForm.active}
                  onChange={(event) =>
                    setPairFirst(
                      event.target.value === "" ? null : event.target.value,
                    )
                  }
                >
                  <option value="">{NOT_ASSIGNED}</option>
                  {(tablets ?? []).map((tablet) => (
                    <option
                      key={tablet.id}
                      value={tablet.id}
                      disabled={!tablet.available}
                    >
                      {tablet.label ?? tablet.id}
                      {tablet.available ? "" : " (nicht verfügbar)"}
                    </option>
                  ))}
                </select>

                <label htmlFor="tablet-2">Tablet 2</label>
                <select
                  id="tablet-2"
                  value={pairSecond ?? ""}
                  disabled={pairing || taxiForm.active}
                  onChange={(event) =>
                    setPairSecond(
                      event.target.value === "" ? null : event.target.value,
                    )
                  }
                >
                  <option value="">{NOT_ASSIGNED}</option>
                  {(tablets ?? []).map((tablet) => (
                    <option
                      key={tablet.id}
                      value={tablet.id}
                      disabled={!tablet.available}
                    >
                      {tablet.label ?? tablet.id}
                      {tablet.available ? "" : " (nicht verfügbar)"}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={pairing || taxiForm.active || unclearWrite}
                >
                  Paar zuordnen
                </button>
              </form>

              <button
                type="button"
                onClick={() => void handleActivation()}
                disabled={
                  taxiActivating ||
                  unclearWrite ||
                  (!taxiForm.active && !confirmedPairComplete)
                }
              >
                {taxiForm.active ? "Taxi deaktivieren" : "Taxi aktivieren"}
              </button>
              <p>
                Verfügbare Tablets:{" "}
                {availableTablets.length === 0
                  ? "Keine"
                  : availableTablets
                      .map((tablet) => tablet.label ?? tablet.id)
                      .join(", ")}
              </p>
            </section>
          ) : null}
        </section>
      ) : null}

      </section>

      <section aria-label="Gruppen">
        <h2>Gruppen</h2>
        <form onSubmit={(event) => void handleCreateGroup(event)} noValidate>
          <label htmlFor="new-group-name">Neue Gruppe</label>
          <input
            id="new-group-name"
            type="text"
            value={newGroupName}
            maxLength={80}
            disabled={groupBusy}
            onChange={(event) => setNewGroupName(event.target.value)}
          />
          <button
            type="submit"
            disabled={groupBusy || unclearWrite}
          >
            Gruppe anlegen
          </button>
        </form>

        {groups !== null && groups.length === 0 ? (
          <p>Keine Gruppen vorhanden.</p>
        ) : null}

        {groups !== null && groups.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    {renamingGroupId === group.id ? (
                      <form
                        onSubmit={(event) =>
                          void handleRenameGroup(event, group)
                        }
                      >
                        <p>
                          Bisheriger Name: <strong>{group.name}</strong>
                        </p>
                        <label htmlFor={`group-name-${group.id}`}>
                          Neuer Gruppenname
                        </label>
                        <input
                          id={`group-name-${group.id}`}
                          type="text"
                          value={renameDraft}
                          maxLength={80}
                          disabled={groupBusy}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                        />
                        <button
                          type="submit"
                          disabled={groupBusy || unclearWrite || renameConflict}
                        >
                          Speichern
                        </button>
                        {renameConflict ? (
                          <button
                            type="button"
                            disabled={groupBusy || loading}
                            onClick={reloadGroupsAfterConflict}
                          >
                            Neu laden
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={groupBusy}
                          onClick={() => {
                            setRenamingGroupId(null);
                            setRenameDraft("");
                            setRenameConflict(false);
                          }}
                        >
                          Abbrechen
                        </button>
                      </form>
                    ) : (
                      group.name
                    )}
                  </td>
                  <td>
                    {renamingGroupId === group.id ? null : (
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingGroupId(group.id);
                          setRenameDraft(group.name);
                          setRenameConflict(false);
                          setActionError(null);
                        }}
                        disabled={groupBusy || unclearWrite}
                      >
                        Umbenennen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section aria-label="Inventar">
        <h2>Inventar</h2>
        <p>
          Sperrung oder Widerruf eines Geräts erfolgt in der{" "}
          <a href="#/geraete">Geräteansicht</a>.
        </p>

        {inventory !== null && inventory.length === 0 ? (
          <p>Keine Geräte im Inventar.</p>
        ) : null}

        {inventory !== null && inventory.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Geräte-ID</th>
                <th scope="col">Seriennummer</th>
                <th scope="col">Gerätetyp</th>
                <th scope="col">Austauschvermerk</th>
                <th scope="col">Verwaltung</th>
                <th scope="col">Aktion</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((item) => (
                <tr key={item.deviceId}>
                  <td>{item.deviceId}</td>
                  <td>{displayOrMissing(item.serialNumber)}</td>
                  <td>{displayOrMissing(item.deviceType)}</td>
                  <td>{displayOrMissing(item.replacementNote)}</td>
                  <td>{item.adminActive ? "Aktiv" : "Inaktiv"}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => startInventoryEdit(item)}
                      disabled={inventoryBusy || unclearWrite}
                    >
                      Bearbeiten
                    </button>
                    {item.adminActive ? (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeactivateId(item.deviceId);
                          setActionError(null);
                        }}
                        disabled={
                          inventoryBusy || deactivating || unclearWrite
                        }
                      >
                        Tablet deaktivieren
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void setTabletActivation(item, true)}
                        disabled={inventoryBusy || unclearWrite}
                      >
                        Tablet aktivieren
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {confirmDeactivateId !== null ? (
          <section aria-label="Tablet-Deaktivierung bestätigen">
            <p>
              Das Tablet <strong>{confirmDeactivateId}</strong> deaktivieren?
              Das zugeordnete Taxi wird ebenfalls deaktiviert.
            </p>
            <p>
              Eine erfolgreiche Fernabschaltung des Geräts wird dabei nicht
              behauptet.
            </p>
            <button
              type="button"
              disabled={deactivating || unclearWrite}
              onClick={() => {
                const item = (inventory ?? []).find(
                  (entry) => entry.deviceId === confirmDeactivateId,
                );
                if (item !== undefined) {
                  void setTabletActivation(item, false);
                }
              }}
            >
              Deaktivierung bestätigen
            </button>
            <button
              type="button"
              disabled={deactivating}
              onClick={() => setConfirmDeactivateId(null)}
            >
              Abbrechen
            </button>
          </section>
        ) : null}

        {selectedInventory !== null ? (
          <section aria-label="Inventar bearbeiten">
            <h3>Inventar {selectedInventory.deviceId}</h3>
            <form
              onSubmit={(event) => void handleInventorySave(event)}
              noValidate
            >
              <p>
                Geräte-ID: <strong>{selectedInventory.deviceId}</strong>
              </p>
              <label htmlFor="inventory-serial">Seriennummer</label>
              <input
                id="inventory-serial"
                type="text"
                value={inventorySerial}
                maxLength={INVENTORY_LIMITS.serialNumber}
                disabled={inventoryBusy}
                onChange={(event) => setInventorySerial(event.target.value)}
              />
              <label htmlFor="inventory-type">Gerätetyp</label>
              <input
                id="inventory-type"
                type="text"
                value={inventoryType}
                maxLength={INVENTORY_LIMITS.deviceType}
                disabled={inventoryBusy}
                onChange={(event) => setInventoryType(event.target.value)}
              />
              <label htmlFor="inventory-note">Austauschvermerk</label>
              <textarea
                id="inventory-note"
                value={inventoryNote}
                maxLength={INVENTORY_LIMITS.replacementNote}
                disabled={inventoryBusy}
                onChange={(event) => setInventoryNote(event.target.value)}
              />
              <button
                type="submit"
                disabled={inventoryBusy || unclearWrite}
              >
                Speichern
              </button>
              <button
                type="button"
                onClick={closeInventoryEdit}
                disabled={inventoryBusy}
              >
                Abbrechen
              </button>
            </form>
          </section>
        ) : null}
      </section>
    </div>
  );
}

