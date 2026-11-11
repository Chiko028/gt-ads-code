import { Pool } from "pg";

/**
 * Liest die Datenbank-Verbindungszeichenfolge aus der Umgebung.
 * Es gibt bewusst keinen Standardwert: ohne GT_ADS_DB_URL wird kein Pool erzeugt.
 */
export function databaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.GT_ADS_DB_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("GT_ADS_DB_URL ist nicht gesetzt");
  }
  return url;
}

/**
 * Erzeugt einen pg-Pool. Der Aufrufer ist fuer das Schliessen (pool.end())
 * verantwortlich.
 */
export function createDatabasePool(
  connectionString: string = databaseUrlFromEnv(),
): Pool {
  return new Pool({ connectionString });
}
