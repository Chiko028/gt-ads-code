import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { computeContentDigest } from "./contentDigest.js";
import { MediaStorageError } from "./errors.js";

const MEDIA_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Serverseitige UUID; nur solche Werte duerfen Pfade bilden. */
export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID_PATTERN.test(value);
}

export function assertMediaId(value: unknown): asserts value is string {
  if (!isMediaId(value)) {
    throw new MediaStorageError("invalid_media_id", "Ungueltiger Medien-Schluessel.");
  }
}

/**
 * Lokaler Speicher unter einem explizit injizierten Stammverzeichnis.
 * Es gibt keinen Produktionspfad und keinen Standardwert.
 */
export class LocalMediaStorage {
  readonly root: string;
  private readonly objectsDirectory: string;
  private readonly stagingDirectory: string;
  private layoutPromise: Promise<void> | null = null;

  constructor(root: string) {
    if (typeof root !== "string" || root.trim() === "") {
      throw new MediaStorageError(
        "invalid_storage_root",
        "Ein lokales Stammverzeichnis ist erforderlich.",
      );
    }
    if (!isAbsolute(root)) {
      throw new MediaStorageError(
        "invalid_storage_root",
        "Das Stammverzeichnis muss absolut sein.",
      );
    }
    if (resolve(root) === parse(resolve(root)).root) {
      throw new MediaStorageError(
        "invalid_storage_root",
        "Das Dateisystem-Wurzelverzeichnis ist nicht zulaessig.",
      );
    }

    this.root = resolve(root);
    this.objectsDirectory = join(this.root, "objects");
    this.stagingDirectory = join(this.root, "staging");
  }

  ensureLayout(): Promise<void> {
    if (this.layoutPromise === null) {
      this.layoutPromise = this.createLayout();
    }
    return this.layoutPromise;
  }

  private async createLayout(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(this.objectsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
  }

  tempPath(id: string): string {
    assertMediaId(id);
    return this.within(this.stagingDirectory, id + ".part");
  }

  finalPath(id: string): string {
    assertMediaId(id);
    return this.within(this.objectsDirectory, id);
  }

  private within(directory: string, name: string): string {
    const candidate = resolve(directory, name);
    if (!candidate.startsWith(directory + sep)) {
      throw new MediaStorageError(
        "path_escape",
        "Der abgeleitete Speicherpfad verlaesst das Stammverzeichnis.",
      );
    }
    return candidate;
  }

  async createTemp(id: string): Promise<FileHandle> {
    await this.ensureLayout();
    try {
      return await open(this.tempPath(id), "wx", 0o600);
    } catch (error) {
      throw new MediaStorageError(
        "temp_create_failed",
        "Die temporaere Datei konnte nicht exklusiv angelegt werden.",
        { cause: error },
      );
    }
  }

  /**
   * Atomare Veroeffentlichung ohne Ueberschreiben: link scheitert mit EEXIST,
   * falls am Ziel bereits ein Objekt liegt. Erst danach wird die temporaere
   * Datei entfernt.
   */
  async publish(id: string): Promise<void> {
    const temp = this.tempPath(id);
    const final = this.finalPath(id);

    try {
      await link(temp, final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MediaStorageError(
          "object_exists",
          "Das Zielobjekt existiert bereits; es wird nicht ueberschrieben.",
          { cause: error },
        );
      }
      throw new MediaStorageError(
        "publish_failed",
        "Die temporaere Datei konnte nicht atomar veroeffentlicht werden.",
        { cause: error },
      );
    }

    // Die finale Datei ist vollstaendig sichtbar; ein verbliebener Temp-Rest
    // ist nicht mehr fachlich relevant und wird best-effort entfernt.
    await unlink(temp).catch(() => undefined);
  }

  async verifyFinal(id: string, sizeBytes: number, sha256: string): Promise<void> {
    if (!(await this.fileMatches(this.finalPath(id), sizeBytes, sha256))) {
      throw new MediaStorageError(
        "final_verification_failed",
        "Die veroeffentlichte Datei stimmt nicht mit den geprueften Bytes ueberein.",
      );
    }
  }

  async finalMatches(id: string, sizeBytes: number, sha256: string): Promise<boolean> {
    return this.fileMatches(this.finalPath(id), sizeBytes, sha256);
  }

  async tempMatches(id: string, sizeBytes: number, sha256: string): Promise<boolean> {
    return this.fileMatches(this.tempPath(id), sizeBytes, sha256);
  }

  private async fileMatches(
    path: string,
    sizeBytes: number,
    sha256: string,
  ): Promise<boolean> {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw new MediaStorageError(
        "file_stat_failed",
        "Die Speicherdatei konnte nicht geprueft werden.",
        { cause: error },
      );
    }

    if (!info.isFile() || info.size !== sizeBytes) {
      return false;
    }

    const digest = await computeContentDigest(createReadStream(path));
    return digest.sizeBytes === sizeBytes && digest.sha256 === sha256;
  }

  async readFinal(id: string, expectedSize: number): Promise<Buffer> {
    const path = this.finalPath(id);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      throw new MediaStorageError(
        "file_missing",
        "Das bereitgestellte Medium ist nicht mehr vorhanden.",
        { cause: error },
      );
    }
    if (!info.isFile() || info.size !== expectedSize) {
      throw new MediaStorageError(
        "file_changed",
        "Das bereitgestellte Medium hat nicht mehr die erwartete Groesse.",
      );
    }
    return readFile(path);
  }

  async removeTemp(id: string): Promise<void> {
    await rm(this.tempPath(id), { force: true });
  }

  async removeFinal(id: string): Promise<void> {
    await rm(this.finalPath(id), { force: true });
  }

  async pathExists(id: string): Promise<boolean> {
    try {
      await stat(this.finalPath(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      return true;
    }
  }
}
