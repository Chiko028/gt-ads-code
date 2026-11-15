/**
 * CX-049 / R-404: oeffentliche Grenze des lesenden Statistikmoduls.
 * Keine neue Persistenz, keine Migration, keine Hintergrundauswertung.
 */
export {
  StatisticsRowLimitError,
  StatisticsService,
  createStatisticsService,
} from "./service.js";
export { parseStatisticsQuery, parseRfc3339Instant } from "./validation.js";
export {
  STATISTICS_MAX_RANGE_MS,
  STATISTICS_ROW_LIMIT,
  SYNC_ERROR_CODE_PREFIX,
} from "./types.js";
export type {
  CompletenessStatus,
  DeviceQualityRow,
  MeasurementDefinition,
  MissingDay,
  PlayRow,
  StatisticsCompleteness,
  StatisticsFilters,
  StatisticsQuery,
  StatisticsResponse,
  StatisticsServiceOptions,
} from "./types.js";

