/**
 * CX-033 / R-101 / R-102: gekapselter JSON-Vertragsbaustein fuer neue Routen.
 *
 * Der Baustein ist bewusst opt-in: Bestandsrouten behalten ihre vorhandene
 * Validierung und ihre lokalen Vertragsfehlerhandler. Neue JSON-Routen koennen
 * Validierung und Fehlerabbildung gemeinsam ueber diese Datei beziehen, ohne
 * globale Parser, Hooks oder Validatoren umzustellen.
 *
 * Validierung: ajv mit removeAdditional=false und coerceTypes=false. Eine
 * Eingabe wird damit weder still um unbekannte Felder bereinigt noch in einen
 * anderen Typ konvertiert. Neue Objektschemata muessen additionalProperties
 * explizit auf false setzen; compileClosedObjectSchema() erzwingt das.
 *
 * Fehler: Bekannte ApiError-Codes behalten Status, Code und Meldung. Nur
 * explizit erkennbare Fastify-Transport-/Parsergrenzen werden abgebildet.
 * Jede unbekannte Ausnahme wird als bereinigtes 500 internal_error
 * ausgeliefert; error.message, error.statusCode, SQL, Cookies oder Stacktraces
 * gelangen nicht in die Antwort.
 */
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import { ApiError, buildErrorBody } from "./errors.js";

// ajv-formats ist CommonJS; der Typ wird explizit auf die Plugin-Signatur
// reduziert, damit NodeNext und der Laufzeit-Default zusammenpassen.
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

/** Feste Validatoroptionen fuer neue JSON-Schemata. */
export const JSON_CONTRACT_VALIDATOR_OPTIONS = Object.freeze({
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
  allErrors: false,
  strict: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Erzwingt geschlossene Objektschemata. Das betrifft das Wurzelschema und
 * verschachtelte Objekte in properties/items/allOf/anyOf/oneOf/additionalProperties.
 * Ein neues Schema ohne additionalProperties=false ist ein Programmierfehler
 * und wird beim Registrieren sichtbar.
 */
export function assertClosedObjectSchemas(
  schema: unknown,
  path: string = "schema",
): void {
  if (!isRecord(schema)) {
    return;
  }
  if (schema.type === "object" && schema.additionalProperties !== false) {
    throw new Error(
      path + ": neue Objektschemata muessen additionalProperties=false setzen.",
    );
  }

  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      assertClosedObjectSchemas(child, path + ".properties." + name);
    }
  }

  if (isRecord(schema.items)) {
    assertClosedObjectSchemas(schema.items, path + ".items");
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const children = schema[keyword];
    if (Array.isArray(children)) {
      children.forEach((child, index) =>
        assertClosedObjectSchemas(child, path + "." + keyword + "[" + index + "]"),
      );
    }
  }

  if (isRecord(schema.additionalProperties)) {
    assertClosedObjectSchemas(
      schema.additionalProperties,
      path + ".additionalProperties",
    );
  }
}

/** Erzeugt einen Validator mit den festen Optionen dieses Bausteins. */
export function createJsonContractValidator(): Ajv {
  const ajv = new Ajv({ ...JSON_CONTRACT_VALIDATOR_OPTIONS });
  addFormats(ajv);
  return ajv;
}

/**
 * Kompiliert ein geschlossenes Objektschema. Die Pruefung erfolgt vor der
 * Kompilierung, damit kein neues Schema versehentlich offen bleibt.
 */
export function compileClosedObjectSchema(
  schema: Record<string, unknown>,
): ValidateFunction {
  assertClosedObjectSchemas(schema);
  return createJsonContractValidator().compile(schema);
}

export type JsonRouteHook = (
  request: FastifyRequest,
  reply: FastifyReply,
) => void | Promise<void>;

export interface JsonRouteDefinition {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** Optionales Wurzel-Body-Schema; muss ein geschlossenes Objekt sein. */
  bodySchema?: Record<string, unknown>;
  /**
   * Optionales routenspezifisches Bodylimit. Ohne Angabe gilt das Limit der
   * App-Instanz; die bestehenden Routen bleiben unveraendert.
   */
  bodyLimit?: number;
  onRequest?: JsonRouteHook | JsonRouteHook[];
  handler: RouteHandlerMethod;
}

/**
 * Registriert eine JSON-Route mit dem gemeinsamen Validierungsbaustein. Der
 * Validator laeuft als preValidation, also nach der vorhandenen
 * Authentifizierung und vor dem Fachhandler. Ungueltige Eingaben ergeben
 * bereinigt 400 invalid_request; der Handler wird nicht ausgefuehrt.
 */
export function registerJsonRoute(
  app: FastifyInstance,
  definition: JsonRouteDefinition,
): void {
  const validate =
    definition.bodySchema === undefined
      ? undefined
      : compileClosedObjectSchema(definition.bodySchema);

  app.route({
    method: definition.method,
    url: definition.url,
    ...(definition.bodyLimit === undefined
      ? {}
      : { bodyLimit: definition.bodyLimit }),
    ...(definition.onRequest === undefined
      ? {}
      : { onRequest: definition.onRequest }),
    ...(validate === undefined
      ? {}
      : {
          preValidation: async (request: FastifyRequest) => {
            if (!validate(request.body)) {
              throw ApiError.invalidRequest();
            }
          },
        }),
    handler: definition.handler,
  });
}

interface FastifyLikeError {
  statusCode?: unknown;
  code?: unknown;
  validation?: unknown;
  name?: unknown;
}

/** Fastify-Parser-/Validierungsfehler sind bekannte 4xx-Grenzen. */
function isKnownFastifyClientError(error: FastifyLikeError): boolean {
  if (typeof error.code === "string" && error.code.startsWith("FST_ERR_")) {
    return true;
  }
  return error.validation !== undefined;
}

function sendApiError(
  error: ApiError,
  requestId: string,
  reply: FastifyReply,
): void {
  for (const [name, value] of Object.entries(error.headers)) {
    reply.header(name, value);
  }
  reply
    .code(error.statusCode)
    .type("application/json; charset=utf-8")
    .send(buildErrorBody(error.code, requestId));
}

/**
 * Installiert den gekapselten Fehlerbaustein in einem Fastify-Kontext. Der
 * Handler gilt nur fuer Routen dieses Kontexts; bestehende lokale Handler und
 * der globale U7-Handler bleiben unberuehrt.
 */
export function installContractErrorHandling(scope: FastifyInstance): void {
  scope.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof ApiError) {
      sendApiError(error, requestId, reply);
      return;
    }

    const fastifyError = error as FastifyLikeError;

    // Vorhandene Transportgrenzen behalten ihren Status (413/415), aber
    // niemals eine fremde Meldung.
    if (fastifyError.statusCode === 413 || fastifyError.statusCode === 415) {
      reply
        .code(fastifyError.statusCode)
        .type("application/json; charset=utf-8")
        .send(buildErrorBody("invalid_request", requestId));
      return;
    }

    if (isKnownFastifyClientError(fastifyError)) {
      reply
        .code(400)
        .type("application/json; charset=utf-8")
        .send(buildErrorBody("invalid_request", requestId));
      return;
    }

    // Unbekannte Ausnahmen: nur der Name wird protokolliert, nie Meldung,
    // Stacktrace, SQL oder Anfragewerte.
    request.log.error(
      {
        errName:
          typeof fastifyError.name === "string"
            ? fastifyError.name
            : "UnknownError",
        requestId,
      },
      "Unbehandelter Fehler",
    );
    reply
      .code(500)
      .type("application/json; charset=utf-8")
      .send(buildErrorBody("internal_error", requestId));
  });
}
