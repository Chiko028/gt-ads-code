/**
 * CX-168: oeffentliche Grenze des App-Release-Moduls.
 */
export {
  AppReleaseService,
  createAppReleaseService,
  issueAppDownloadTicket,
  verifyAppDownloadTicket,
  AppReleaseValidationError,
  AppReleaseConflictError,
  AppReleaseNotFoundError,
  AppReleaseStorageError,
  APP_RELEASE_MAX_BYTES,
  APP_RELEASE_MAX_NAME_LENGTH,
  APP_RELEASE_MAX_NOTES_LENGTH,
  APP_RELEASE_TICKET_TTL_SECONDS,
  APP_RELEASE_MIN_SECRET_BYTES,
} from "./service.js";
export type {
  AppRelease,
  AppReleaseOverview,
  AppReleaseRollout,
  AppUpdateChannel,
  AppReportStatus,
  AppDownloadResult,
  AppDownloadTicketPayload,
  AppReleaseServiceOptions,
  CreateAppReleaseInput,
} from "./service.js";
