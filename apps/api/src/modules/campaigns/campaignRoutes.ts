/**
 * CX-038 / R-205: duenne HTTP-Verdrahtung der Kampagnen.
 *
 * Wiederverwendet werden ausschliesslich vorhandene Bausteine: Admin-Sitzung
 * und Schreibschutz (CX-032/U6), der gekapselte JSON-Vertrag (CX-033) und die
 * Laufzeitpruefung (CX-004). Hier entsteht weder eine neue Rechtehierarchie
 * noch eine zweite Persistenz.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../../http/errors.js";
import { registerJsonRoute } from "../../http/jsonContract.js";
import {
  createAdminSessionMiddleware,
  requireAdminWrite,
} from "../adminAuth/middleware.js";
import {
  ADMIN_ACTOR_ID,
  type AdminAuthService,
} from "../adminAuth/service.js";
import {
  CAMPAIGN_DETAIL_PATH,
  CAMPAIGN_LIST_DEFAULT_LIMIT,
  CAMPAIGN_LIST_MAX_LIMIT,
  CAMPAIGN_LIST_PATH,
  CAMPAIGN_RULE_TYPE,
  type Campaign,
  type CampaignService,
} from "./campaigns.js";

export interface CampaignRoutesDeps {
  service: CampaignService;
  adminAuth: AdminAuthService;
}

interface CampaignJson {
  id: string;
  customer_id: string;
  media_id: string;
  rule_type: string;
  status: string;
  archived: boolean;
  start_at: string;
  end_at: string;
  taxi_ids: string[];
  group_ids: string[];
  revision: number;
  created_at: string;
  updated_at: string;
}

function toJson(campaign: Campaign): CampaignJson {
  return {
    id: campaign.id,
    customer_id: campaign.customerId,
    media_id: campaign.mediaId,
    rule_type: CAMPAIGN_RULE_TYPE,
    status: campaign.status,
    archived: campaign.archived,
    start_at: campaign.startAt,
    end_at: campaign.endAt,
    taxi_ids: [...campaign.taxiIds],
    group_ids: [...campaign.groupIds],
    revision: campaign.revision,
    created_at: campaign.createdAt.toISOString(),
    updated_at: campaign.updatedAt.toISOString(),
  };
}

/** Geschlossenes Schema: nur die bekannten Felder, keine stille Bereinigung. */
const CREATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["customer_id", "media_id", "start_at", "end_at"],
  properties: {
    customer_id: { type: "string" },
    media_id: { type: "string" },
    rule_type: { type: "string", enum: [CAMPAIGN_RULE_TYPE] },
    status: { type: "string", enum: ["draft", "active"] },
    start_at: { type: "string" },
    end_at: { type: "string" },
    taxi_ids: {
      type: "array",
      maxItems: 200,
      items: { type: "string" },
    },
    group_ids: {
      type: "array",
      maxItems: 200,
      items: { type: "string" },
    },
  },
};

const UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: {
      type: "string",
      enum: ["draft", "active", "paused", "finished"],
    },
    archived: { type: "boolean" },
    media_id: { type: "string" },
    start_at: { type: "string" },
    end_at: { type: "string" },
    taxi_ids: {
      type: "array",
      maxItems: 200,
      items: { type: "string" },
    },
    group_ids: {
      type: "array",
      maxItems: 200,
      items: { type: "string" },
    },
    revision: { type: "integer", minimum: 1 },
  },
};

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw ApiError.invalidRequest();
  }
  return body as Record<string, unknown>;
}

/** Der authentifizierte Betreiberbereich; keine Client-Angabe. */
function ownerOf(request: FastifyRequest): string {
  const principal = request.accessPrincipal;
  return principal !== undefined && principal.id.length > 0
    ? principal.id
    : ADMIN_ACTOR_ID;
}

/** Ausschliesslich optionales limit als ganze Zahl 1..100. */
function parseListLimit(query: unknown): number {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw ApiError.invalidRequest();
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "limit") {
      throw ApiError.invalidRequest();
    }
  }
  const raw = record.limit;
  if (raw === undefined) {
    return CAMPAIGN_LIST_DEFAULT_LIMIT;
  }
  if (typeof raw !== "string" || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) {
    throw ApiError.invalidRequest();
  }
  return Number(raw);
}

/**
 * Registriert die vier Kampagnenrouten. POST/PATCH nutzen zusaetzlich den
 * vorhandenen Schreibschutz (JSON-Content-Type und Origin).
 */
export function registerCampaignRoutes(
  app: FastifyInstance,
  deps: CampaignRoutesDeps,
): void {
  const sessionGuard = createAdminSessionMiddleware(deps.adminAuth);

  app.get(
    CAMPAIGN_LIST_PATH,
    { onRequest: [sessionGuard] },
    async (request, reply) => {
      const limit = parseListLimit(request.query);
      const items = await deps.service.listCampaigns(ownerOf(request), limit);
      reply.code(200).send({ items: items.map(toJson) });
    },
  );

  app.get(
    CAMPAIGN_DETAIL_PATH,
    { onRequest: [sessionGuard] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const campaign = await deps.service.getCampaign(id, ownerOf(request));
      if (campaign === null) {
        throw ApiError.notFound();
      }
      reply.code(200).send(toJson(campaign));
    },
  );

  registerJsonRoute(app, {
    method: "POST",
    url: CAMPAIGN_LIST_PATH,
    bodySchema: CREATE_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const body = bodyOf(request);
      const campaign = await deps.service.createCampaign({
        customerId: body.customer_id,
        mediaId: body.media_id,
        startAt: body.start_at,
        endAt: body.end_at,
        taxiIds: body.taxi_ids,
        groupIds: body.group_ids,
        status: body.status,
        ruleType: body.rule_type,
        ownerId: ownerOf(request),
        actorId: ADMIN_ACTOR_ID,
      });
      reply.code(201).send(toJson(campaign));
    },
  });

  registerJsonRoute(app, {
    method: "PATCH",
    url: CAMPAIGN_DETAIL_PATH,
    bodySchema: UPDATE_SCHEMA,
    onRequest: [requireAdminWrite, sessionGuard],
    handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = bodyOf(request);
      const campaign = await deps.service.updateCampaign(
        id,
        {
          status: body.status,
          archived: body.archived,
          mediaId: body.media_id,
          startAt: body.start_at,
          endAt: body.end_at,
          taxiIds: body.taxi_ids,
          groupIds: body.group_ids,
          revision: body.revision,
          actorId: ADMIN_ACTOR_ID,
        },
        ownerOf(request),
      );
      reply.code(200).send(toJson(campaign));
    },
  });
}

