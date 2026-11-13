import { TechnicalAlarmInputError } from "./errors.js";

/**
 * CX-029: austauschbarer Versandadapter fuer technische Alarmauftraege.
 *
 * Der Port ist bewusst frei von Netzwerkcode. Ein Transport wird immer
 * explizit injiziert; es gibt weder fetch noch einen HTTP-Client oder ein
 * Telegram-SDK als Standard. Ohne Transport oder Zielkonfiguration meldet der
 * Adapter einen sichtbaren Blocker und niemals Erfolg.
 */

/** Daten, die eine Alarmnachricht hoechstens enthalten darf. */
export interface AlarmDeliveryMessage {
  /** Dauerhafte Alarm-ID (Episode); bleibt bei Wiederholungen stabil. */
  alarmId: string;
  /** Pseudonyme Ressourcenkennung, z. B. eine Tablet-ID. */
  resourceRef: string;
  /** Validierter technischer Fehlercode aus der Episode. */
  errorCode: string;
  /** UTC-Zeitpunkt des Alarms als ISO-8601-Zeichenkette. */
  occurredAt: string;
}

export type AlarmSenderBlockReason =
  | "sender_missing"
  | "transport_missing"
  | "target_missing";

/**
 * Ergebnis eines Adapteraufrufs. "blocked" ist ausdruecklich kein Erfolg und
 * fuehrt nicht zu einem Versandversuch.
 */
export type AlarmSendOutcome =
  | { kind: "sent" }
  | { kind: "blocked"; reason: AlarmSenderBlockReason }
  | {
      kind: "retryable";
      errorCode: string;
      retryAfterSeconds?: number | null;
    }
  | { kind: "permanent"; errorCode: string };

export interface AlarmSendOptions {
  /** Abbruchsignal; der Aufrufer begrenzt den Aufruf zeitlich. */
  signal: AbortSignal;
}

/** Austauschbarer Versandadapter. */
export interface AlarmSender {
  send(
    message: AlarmDeliveryMessage,
    options: AlarmSendOptions,
  ): Promise<AlarmSendOutcome>;
}

/** Zielkonfiguration; der Bot-Token ist ein Geheimnis. */
export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/**
 * Anfrage an den Transport. Das Geheimnis (botToken) und die Ziel-ID (chatId)
 * stehen getrennt vom protokollierbaren Text.
 */
export interface TelegramSendMessageRequest {
  botToken: string;
  chatId: string;
  /** Nur protokollierbarer Nachrichtentext; enthaelt keine Geheimnisse. */
  text: string;
}

export interface TelegramTransportResponse {
  status: number;
  headers?: Record<string, string | undefined> | null;
  /** Bereits dekodierte JSON-Antwort, falls vorhanden. */
  body?: unknown;
}

/** Schmaler Transport-Port; wird verpflichtend injiziert. */
export interface TelegramTransport {
  sendMessage(
    request: TelegramSendMessageRequest,
    options: AlarmSendOptions,
  ): Promise<TelegramTransportResponse>;
}

export interface TelegramSenderOptions {
  /**
   * Pflichtangabe ohne Default. null bedeutet: kein Transport konfiguriert.
   * Es wird niemals ein Netzwerkclient ersatzweise erzeugt.
   */
  transport: TelegramTransport | null;
  target?: TelegramTarget | null;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function singleLine(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").trim();
}

function usableTarget(
  target: TelegramTarget | null | undefined,
): TelegramTarget | null {
  if (target === null || target === undefined) {
    return null;
  }
  const botToken =
    typeof target.botToken === "string" ? target.botToken.trim() : "";
  const chatId = typeof target.chatId === "string" ? target.chatId.trim() : "";
  if (botToken === "" || chatId === "") {
    return null;
  }
  if (CONTROL_CHARACTER.test(botToken) || CONTROL_CHARACTER.test(chatId)) {
    return null;
  }
  return { botToken, chatId };
}

/**
 * Baut den protokollierbaren Nachrichtentext. Nur Alarm-ID, pseudonyme
 * Ressourcenkennung, validierter Fehlercode und UTC-Zeit; kein parse_mode,
 * keine Rohdaten, keine Ziel-ID und kein Token.
 */
export function formatAlarmMessage(message: AlarmDeliveryMessage): string {
  if (typeof message.alarmId !== "string" || message.alarmId.trim() === "") {
    throw new TechnicalAlarmInputError("alarmId fehlt fuer die Alarmnachricht.");
  }
  if (
    typeof message.resourceRef !== "string" ||
    message.resourceRef.trim() === ""
  ) {
    throw new TechnicalAlarmInputError(
      "resourceRef fehlt fuer die Alarmnachricht.",
    );
  }
  if (typeof message.errorCode !== "string" || message.errorCode.trim() === "") {
    throw new TechnicalAlarmInputError(
      "errorCode fehlt fuer die Alarmnachricht.",
    );
  }
  if (
    typeof message.occurredAt !== "string" ||
    Number.isNaN(Date.parse(message.occurredAt))
  ) {
    throw new TechnicalAlarmInputError(
      "occurredAt ist kein gueltiger Zeitpunkt.",
    );
  }
  return [
    "Technischer Alarm",
    "Alarm-ID: " + singleLine(message.alarmId),
    "Ressource: " + singleLine(message.resourceRef),
    "Fehlercode: " + singleLine(message.errorCode),
    "Zeit (UTC): " + new Date(Date.parse(message.occurredAt)).toISOString(),
  ].join("\n");
}

function readHeader(
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
): string | null {
  if (headers === null || headers === undefined) {
    return null;
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) {
      const value = headers[key];
      return typeof value === "string" ? value : null;
    }
  }
  return null;
}

function parseSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

function telegramOk(body: unknown): boolean {
  const record = bodyRecord(body);
  return record !== null && record.ok === true;
}

/** Liest parameters.retry_after aus einer Telegram-Fehlerantwort. */
export function telegramRetryAfterSeconds(body: unknown): number | null {
  const record = bodyRecord(body);
  if (record === null) {
    return null;
  }
  const parameters = bodyRecord(record.parameters);
  if (parameters === null) {
    return null;
  }
  return parseSeconds(parameters.retry_after);
}

/** Bildet HTTP-Antwort und Telegram-Status auf ein Versandergebnis ab. */
export function mapTelegramResponse(
  response: TelegramTransportResponse,
): AlarmSendOutcome {
  const status = response.status;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
    return { kind: "retryable", errorCode: "telegram_unexpected_status" };
  }

  if (status === 429) {
    const retryAfterSeconds =
      parseSeconds(readHeader(response.headers, "retry-after")) ??
      telegramRetryAfterSeconds(response.body);
    return {
      kind: "retryable",
      errorCode: "telegram_rate_limited",
      retryAfterSeconds,
    };
  }

  if (status >= 200 && status <= 299) {
    // Erfolg verlangt HTTP-Erfolg und Telegram ok=true.
    if (telegramOk(response.body)) {
      return { kind: "sent" };
    }
    return { kind: "retryable", errorCode: "telegram_not_ok" };
  }

  if (status >= 400 && status <= 499) {
    return { kind: "permanent", errorCode: "telegram_client_error" };
  }

  if (status >= 500 && status <= 599) {
    return { kind: "retryable", errorCode: "telegram_server_error" };
  }

  return { kind: "retryable", errorCode: "telegram_unexpected_status" };
}

/**
 * Bildet eine sendMessage-Anfrage auf den injizierten Transport ab.
 *
 * Der Adapter kennt keine URL und keinen HTTP-Client. Der Transport erhaelt
 * Token und Ziel-ID getrennt vom Text; der Text enthaelt nur die freigegebenen
 * Alarmfelder.
 */
export class TelegramSender implements AlarmSender {
  private readonly transport: TelegramTransport | null;
  private readonly target: TelegramTarget | null;

  constructor(options: TelegramSenderOptions) {
    this.transport = options.transport ?? null;
    this.target = options.target ?? null;
  }

  async send(
    message: AlarmDeliveryMessage,
    options: AlarmSendOptions,
  ): Promise<AlarmSendOutcome> {
    if (this.transport === null) {
      return { kind: "blocked", reason: "transport_missing" };
    }
    const target = usableTarget(this.target);
    if (target === null) {
      return { kind: "blocked", reason: "target_missing" };
    }
    const text = formatAlarmMessage(message);
    const response = await this.transport.sendMessage(
      { botToken: target.botToken, chatId: target.chatId, text },
      { signal: options.signal },
    );
    return mapTelegramResponse(response);
  }
}

export function createTelegramSender(
  options: TelegramSenderOptions,
): TelegramSender {
  return new TelegramSender(options);
}
