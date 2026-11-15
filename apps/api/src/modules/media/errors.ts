import type { MediaProfileError } from "./profile.js";

/** Stabiler Fehlercode des Medienspeichers. */
export class MediaError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MediaError";
    this.code = code;
  }
}

/** Abgelehnte Eingabe; es entsteht kein sichtbares Medium. */
export class MediaInputError extends MediaError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "MediaInputError";
  }
}

/** CX-003 hat das Medienprofil abgelehnt. */
export class MediaProfileRejectedError extends MediaInputError {
  readonly errors: readonly MediaProfileError[];

  constructor(errors: readonly MediaProfileError[]) {
    super(
      "invalid_media_profile",
      "Die geprueften Medienmetadaten erfuellen das Profil nicht.",
    );
    this.name = "MediaProfileRejectedError";
    this.errors = errors;
  }
}

/** Das Medium existiert nicht, ist nicht bereit oder ist nicht sichtbar. */
export class MediaNotFoundError extends MediaError {
  constructor(id: string) {
    super("media_not_found", "Das Medium wurde nicht gefunden.");
    this.name = "MediaNotFoundError";
    this.mediaId = id;
  }

  readonly mediaId: string;
}

/** Das Medium wird noch von einer aktiven Kampagne verwendet. */
export class MediaInUseError extends MediaError {
  constructor(id: string) {
    super(
      "media_in_use",
      "Das Medium wird von einer aktiven Kampagne verwendet.",
    );
    this.name = "MediaInUseError";
    this.mediaId = id;
  }

  readonly mediaId: string;
}

/** Dateisystem- oder Datenbankfehler; der Zustand ready wurde nicht gesetzt. */
export class MediaStorageError extends MediaError {
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(code, message, options);
    this.name = "MediaStorageError";
  }
}
