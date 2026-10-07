import {
  DatabaseConstraintError,
  type DatabaseJson,
  type HotUpdaterDatabase,
} from "@hot-updater/plugin-core";

import type { RemoteConfigFetchResponse } from "../shared/wire";
import type { RemoteConfigSchema } from "./schema";
import {
  EMPTY_REMOTE_CONFIG_TEMPLATE,
  type RemoteConfigEvaluationContext,
  type RemoteConfigTemplate,
  resolveRemoteConfigValues,
  validateRemoteConfigTemplate,
} from "./template";

const ACTIVE_ID = "active";
/** How long a server answers fetches from the active template it read last. */
const ACTIVE_CACHE_TTL_MS = 5_000;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_VERSIONS_PAGE = 100;

/** A published version's record, without its template. */
export interface RemoteConfigVersion {
  readonly version: number;
  readonly description: string | null;
  /** `ROLLBACK` when the version copies `rollbackSource`. */
  readonly updateType: "PUBLISH" | "ROLLBACK";
  readonly rollbackSource: number | null;
  readonly createdAtMs: number;
}

export interface RemoteConfigVersionDetail extends RemoteConfigVersion {
  readonly template: RemoteConfigTemplate;
}

/** The template devices receive now. */
export interface RemoteConfigActive {
  /** 0, with an empty template, before the first publish. */
  readonly version: number;
  readonly template: RemoteConfigTemplate;
  readonly updatedAtMs: number | null;
}

/**
 * How a publish or a rollback ended: `conflict` when another publish moved
 * the active version past `baseVersion` first, so a stale edit never
 * replaces a newer template.
 */
export type RemoteConfigPublishResult =
  | { readonly status: "published"; readonly version: RemoteConfigVersion }
  | { readonly status: "conflict"; readonly currentVersion: number };

export interface RemoteConfigVersionsPage {
  /** Newest first. */
  readonly versions: readonly RemoteConfigVersion[];
  /** Pass as `cursor` for the next page; absent on the last one. */
  readonly next?: string;
}

/** `hotUpdater.api.remoteConfig`. */
export interface RemoteConfigApi {
  /** The active template and its version. */
  getActive(): Promise<RemoteConfigActive>;
  /**
   * Validates and publishes a template as the next version. Throws
   * `RemoteConfigValidationError` for an invalid template.
   */
  publish(input: {
    readonly template: unknown;
    /** The version the edit started from; 0 before the first publish. */
    readonly baseVersion: number;
    readonly description?: string;
  }): Promise<RemoteConfigPublishResult>;
  /** Publishes a copy of an earlier version; `not_found` when it does not exist. */
  rollback(input: {
    readonly version: number;
    readonly baseVersion: number;
    readonly description?: string;
  }): Promise<RemoteConfigPublishResult | { readonly status: "not_found" }>;
  /** One page of published versions, newest first. */
  listVersions(input?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<RemoteConfigVersionsPage>;
  /** One version with its template, or null. */
  getVersion(version: number): Promise<RemoteConfigVersionDetail | null>;
  /** What a device with this context receives from `GET /remote-config`. */
  resolve(
    context: RemoteConfigEvaluationContext,
  ): Promise<RemoteConfigFetchResponse>;
}

/**
 * An argument the API refuses, such as a negative `baseVersion`; the admin
 * routes answer it with `400`.
 */
export class RemoteConfigInputError extends TypeError {
  override readonly name = "RemoteConfigInputError";
}

const normalizeDescription = (description: unknown): string | null => {
  if (description === undefined || description === null) return null;
  if (typeof description !== "string") {
    throw new RemoteConfigInputError("A version description is text.");
  }
  const trimmed = description.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new RemoteConfigInputError(
      `A version description holds up to ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return trimmed.length === 0 ? null : trimmed;
};

const requireVersionNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RemoteConfigInputError(`${name} must be a non-negative integer.`);
  }
  return value;
};

/** A template as its `json` column stores it; validation made it plain JSON. */
const toColumn = (template: RemoteConfigTemplate): DatabaseJson =>
  template as unknown as DatabaseJson;
const fromColumn = (value: DatabaseJson): RemoteConfigTemplate =>
  value as unknown as RemoteConfigTemplate;

type VersionRow = {
  readonly version: number;
  readonly template: DatabaseJson;
  readonly description: string | null;
  readonly update_type: string;
  readonly rollback_source: number | null;
  readonly created_at_ms: number;
};

const toVersion = (row: VersionRow): RemoteConfigVersion =>
  Object.freeze({
    version: row.version,
    description: row.description,
    updateType: row.update_type === "ROLLBACK" ? "ROLLBACK" : "PUBLISH",
    rollbackSource: row.rollback_source,
    createdAtMs: row.created_at_ms,
  });

/** Remote Config's API over its tables. */
export const createRemoteConfigApi = ({
  db,
  now,
}: {
  readonly db: HotUpdaterDatabase<RemoteConfigSchema>;
  readonly now: () => number;
}): RemoteConfigApi => {
  let cached: {
    readonly active: RemoteConfigActive;
    readonly expiresAt: number;
  } | null = null;
  let loading: Promise<RemoteConfigActive> | null = null;
  // Bumped by every publish here, so a read that started before it never
  // caches the template it replaced.
  let generation = 0;

  const readActive = async (): Promise<RemoteConfigActive> => {
    const row = await db.findOne("remote_config_active", { id: ACTIVE_ID });
    return row === null
      ? {
          version: 0,
          template: EMPTY_REMOTE_CONFIG_TEMPLATE,
          updatedAtMs: null,
        }
      : {
          version: row.version,
          template: fromColumn(row.template),
          updatedAtMs: row.updated_at_ms,
        };
  };

  /** The active template for fetches: one read per server every few seconds at most. */
  const servedActive = (): Promise<RemoteConfigActive> => {
    if (cached !== null && cached.expiresAt > now()) {
      return Promise.resolve(cached.active);
    }
    if (loading !== null) return loading;
    const started = generation;
    const read: Promise<RemoteConfigActive> = readActive()
      .then((active) => {
        if (generation === started) {
          cached = { active, expiresAt: now() + ACTIVE_CACHE_TTL_MS };
        }
        return active;
      })
      .finally(() => {
        if (loading === read) loading = null;
      });
    loading = read;
    return read;
  };

  const commit = async (input: {
    readonly template: RemoteConfigTemplate;
    readonly baseVersion: number;
    readonly description: string | null;
    readonly rollbackSource: number | null;
  }): Promise<RemoteConfigPublishResult> => {
    const attempt = () =>
      db.transaction(async (tx): Promise<RemoteConfigPublishResult> => {
        const active = await tx.findOne("remote_config_active", {
          id: ACTIVE_ID,
        });
        const currentVersion = active?.version ?? 0;
        if (currentVersion !== input.baseVersion) {
          return { status: "conflict", currentVersion };
        }
        const version = currentVersion + 1;
        const at = now();
        const row = {
          version,
          template: toColumn(input.template),
          description: input.description,
          update_type: input.rollbackSource === null ? "PUBLISH" : "ROLLBACK",
          rollback_source: input.rollbackSource,
          created_at_ms: at,
        };
        tx.create("remote_config_versions", row);
        if (active === null) {
          tx.create("remote_config_active", {
            id: ACTIVE_ID,
            version,
            template: toColumn(input.template),
            updated_at_ms: at,
          });
        } else {
          tx.update("remote_config_active", active, {
            version,
            template: toColumn(input.template),
            updated_at_ms: at,
          });
        }
        return { status: "published", version: toVersion(row) };
      });
    try {
      const result = await attempt();
      if (result.status === "published") {
        generation += 1;
        cached = null;
        loading = null;
      }
      return result;
    } catch (error) {
      // Another publish created the same version or the first active row.
      if (
        error instanceof DatabaseConstraintError &&
        (error.reason === "exists" || error.reason === "unique")
      ) {
        return {
          status: "conflict",
          currentVersion: (await readActive()).version,
        };
      }
      throw error;
    }
  };

  const api: RemoteConfigApi = {
    getActive: readActive,
    publish: async ({ template, baseVersion, description }) =>
      commit({
        template: validateRemoteConfigTemplate(template),
        baseVersion: requireVersionNumber(baseVersion, "baseVersion"),
        description: normalizeDescription(description),
        rollbackSource: null,
      }),
    rollback: async ({ version, baseVersion, description }) => {
      const source = await db.findOne("remote_config_versions", {
        version: requireVersionNumber(version, "version"),
      });
      if (source === null) return { status: "not_found" } as const;
      return commit({
        template: fromColumn(source.template),
        baseVersion: requireVersionNumber(baseVersion, "baseVersion"),
        description:
          normalizeDescription(description) ??
          `Rollback to version ${source.version}`,
        rollbackSource: source.version,
      });
    },
    listVersions: async ({ limit = 20, cursor } = {}) => {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_VERSIONS_PAGE
      ) {
        throw new RemoteConfigInputError(
          `limit must be an integer from 1 to ${MAX_VERSIONS_PAGE}.`,
        );
      }
      const page = await db.findMany("remote_config_versions", {
        index: "byVersion",
        where: {},
        order: "desc",
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return Object.freeze({
        versions: Object.freeze(page.rows.map(toVersion)),
        ...(page.next === undefined ? {} : { next: page.next }),
      });
    },
    getVersion: async (version) => {
      const row = await db.findOne("remote_config_versions", {
        version: requireVersionNumber(version, "version"),
      });
      return row === null
        ? null
        : Object.freeze({
            ...toVersion(row),
            template: fromColumn(row.template),
          });
    },
    resolve: async (context) => {
      const active = await servedActive();
      return {
        version: active.version,
        values: resolveRemoteConfigValues(active.template, context),
      };
    },
  };
  return Object.freeze(api);
};
