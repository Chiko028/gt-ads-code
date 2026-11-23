/**
 * CX-159: oeffentliche Grenze des Spot-Abspielmoduls.
 */
export {
  SpotPlayService,
  createSpotPlayService,
  normalizeSpotPlayBatch,
  parseMonth,
  SPOT_PLAY_MIN_BATCH_SIZE,
  SPOT_PLAY_MAX_BATCH_SIZE,
  SPOT_PLAY_MAX_PLAYED_MS,
  SPOT_PLAY_TIME_TOLERANCE_MS,
  SpotPlayValidationError,
  SpotPlayConflictError,
  SpotPlayStorageError,
} from "./service.js";
export type {
  NormalizedSpotPlay,
  SpotPlayIngestResult,
  SpotPlayTotals,
  SpotPlayPerTaxi,
  SpotPlayPerMedia,
  MonthlySpotPlaySummary,
  SpotPlayServiceOptions,
} from "./service.js";
