/**
 * CX-042 / R-302: einziger, duenner Leseadapter des Manifest-Abrufs.
 *
 * Er liest ausschliesslich zwei serverseitige Quellen:
 * 1. die Taxi-/Tabletzuordnung der authentifizierten Geraete-ID und
 * 2. das in taxi_manifest_state.current_version referenzierte Artefakt.
 *
 * Es gibt keine zweite Manifestpersistenz, keine Signatur, keine Erzeugung
 * und kein Umschreiben von Bytes. Ein offener Neuerzeugungsstand
 * (requested_revision > processed_revision) aendert die Referenz nicht.
 *
 * Die Zuordnung wird aus der vorhandenen CX-035-Leseflaeche
 * (device_taxi_assignments: device_id, taxi_id, active) gelesen. Dieser
 * Adapter legt keine Tabelle an und schreibt nichts.
 */
import type { Pool } from "pg";
import {
  MANIFEST_SCHEMA_VERSION,
  type ManifestEnvironment,
  type SignedManifestEnvelope,
} from "../playout/manifest.js";

export interface TabletAssignment {
  deviceId: string;
  taxiId: string;
  active: boolean;
}

export interface StoredManifestArtifact {
  taxiId: string;
  version: string;
  keyId: string;
  environment: ManifestEnvironment;
  payloadBase64: string;
  signatureBase64: string;
  envelope: SignedManifestEnvelope;
}

export interface DeviceManifestReader {
  /** Zuordnung genau der authentifizierten Geraete-ID oder null. */
  findAssignment(deviceId: string): Promise<TabletAssignment | null>;
  /** Zuletzt vollstaendig veroeffentlichtes Artefakt oder null. */
  getCurrentArtifact(taxiId: string): Promise<StoredManifestArtifact | null>;
}

interface AssignmentRow {
  device_id: string;
  taxi_id: string;
  active: boolean;
}

interface ArtifactRow {
  taxi_id: string;
  version: string;
  key_id: string;
  environment: ManifestEnvironment;
  payload_base64: string;
  signature_base64: string;
}

export function createSqlDeviceManifestReader(
  pool: Pool,
): DeviceManifestReader {
  return {
    async findAssignment(deviceId: string): Promise<TabletAssignment | null> {
      const result = await pool.query<AssignmentRow>(
        [
          "select device_id::text as device_id, taxi_id, active",
          "  from device_taxi_assignments",
          " where device_id = $1",
        ].join("\n"),
        [deviceId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        deviceId: row.device_id,
        taxiId: row.taxi_id,
        active: row.active,
      };
    },

    async getCurrentArtifact(
      taxiId: string,
    ): Promise<StoredManifestArtifact | null> {
      const result = await pool.query<ArtifactRow>(
        [
          "select a.taxi_id, a.version, a.key_id, a.environment,",
          "       a.payload_base64, a.signature_base64",
          "  from taxi_manifest_state s",
          "  join taxi_manifest_artifacts a",
          "    on a.taxi_id = s.taxi_id and a.version = s.current_version",
          " where s.taxi_id = $1",
        ].join("\n"),
        [taxiId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        taxiId: row.taxi_id,
        version: row.version,
        keyId: row.key_id,
        environment: row.environment,
        payloadBase64: row.payload_base64,
        signatureBase64: row.signature_base64,
        envelope: {
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          keyId: row.key_id,
          version: row.version,
          payloadBase64: row.payload_base64,
          signatureBase64: row.signature_base64,
        },
      };
    },
  };
}

