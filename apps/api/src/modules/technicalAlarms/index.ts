export {
  alarmClassificationFromCx010,
  isCx010ClassificationKey,
} from "./adapter.js";
export type { Cx010AlarmEvidence } from "./adapter.js";
export {
  backoffSeconds,
  CLAIM_DUE_ORDER_SQL,
  dispatchPending,
  FINISH_CLAIMED_ORDER_SQL,
  TECHNICAL_ALARM_DEFAULT_BACKOFF_BASE_SECONDS,
  TECHNICAL_ALARM_DEFAULT_BACKOFF_MAX_SECONDS,
  TECHNICAL_ALARM_DEFAULT_BATCH_LIMIT,
  TECHNICAL_ALARM_DEFAULT_LEASE_SECONDS,
  TECHNICAL_ALARM_DEFAULT_MAX_ATTEMPTS,
  TECHNICAL_ALARM_DEFAULT_SEND_TIMEOUT_MS,
  TECHNICAL_ALARM_DELIVERY_AUDIT_FIELDS,
  TECHNICAL_ALARM_DELIVERY_BLOCKED_ACTION,
  TECHNICAL_ALARM_DELIVERY_FAILED_ACTION,
  TECHNICAL_ALARM_DELIVERY_RETRY_ACTION,
  TECHNICAL_ALARM_DELIVERY_SENT_ACTION,
  TECHNICAL_ALARM_DELIVERY_TARGET_TYPE,
} from "./dispatch.js";
export type {
  DispatchOrderOutcome,
  DispatchOrderResult,
  DispatchPendingOptions,
  DispatchPendingResult,
} from "./dispatch.js";
export {
  TechnicalAlarmError,
  TechnicalAlarmInputError,
  TechnicalAlarmStorageError,
} from "./errors.js";
export {
  PostgresTechnicalAlarmRepository,
  mapEpisodeRow,
  mapOutboxRow,
  mapStateVersion,
} from "./repository.js";
export {
  TECHNICAL_ALARM_AUDIT_TARGET_TYPE,
  TECHNICAL_ALARM_OPENED_ACTION,
  TECHNICAL_ALARM_OPENED_AUDIT_FIELDS,
  TECHNICAL_ALARM_RESOLVED_ACTION,
  TECHNICAL_ALARM_RESOLVED_AUDIT_FIELDS,
  TechnicalAlarmService,
  createTechnicalAlarmService,
} from "./service.js";
export {
  formatAlarmMessage,
  mapTelegramResponse,
  TelegramSender,
  createTelegramSender,
  telegramRetryAfterSeconds,
} from "./telegramSender.js";
export type {
  AlarmDeliveryMessage,
  AlarmSendOptions,
  AlarmSendOutcome,
  AlarmSender,
  AlarmSenderBlockReason,
  TelegramSendMessageRequest,
  TelegramSenderOptions,
  TelegramTarget,
  TelegramTransport,
  TelegramTransportResponse,
} from "./telegramSender.js";
export {
  normalizeTechnicalAlarmInput,
  parseTimestamp,
  validateErrorCode,
  validateMinDurationSeconds,
} from "./validation.js";
export type {
  NormalizedTechnicalAlarmClassification,
  NormalizedTechnicalAlarmInput,
} from "./validation.js";
export type {
  TechnicalAlarmAuditWriter,
  TechnicalAlarmClassification,
  TechnicalAlarmClassificationKey,
  TechnicalAlarmDeliveryOrder,
  TechnicalAlarmDeliveryStatus,
  TechnicalAlarmEpisode,
  TechnicalAlarmEpisodeStatus,
  TechnicalAlarmEvaluationInput,
  TechnicalAlarmEvaluationOutcome,
  TechnicalAlarmEvaluationResult,
  TechnicalAlarmRepositoryPort,
  TechnicalAlarmServiceOptions,
  TechnicalAlarmSqlClient,
  TechnicalAlarmSqlConnection,
  TechnicalAlarmSqlPool,
} from "./types.js";
