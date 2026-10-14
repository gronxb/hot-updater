import { InitError } from "@hot-updater/cli-tools";

const VERCEL_API_URL = "https://api.vercel.com";

export class VercelApiError extends InitError {
  readonly name = "VercelApiError";

  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface VercelTeam {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface VercelUser {
  readonly id: string;
  readonly username: string;
  /**
   * Whether the account's resources live in teams only. An account Vercel
   * has not moved to teams also has a personal scope, which takes no teamId.
   */
  readonly teamsOnly: boolean;
}

export interface VercelProject {
  readonly id: string;
  readonly name: string;
  /** The production domains Vercel assigned, such as `<name>.vercel.app`. */
  readonly productionAliases: readonly string[];
}

export interface VercelBlobStoreConnection {
  readonly id: string;
  readonly projectId: string;
  readonly environments: readonly string[];
  readonly environmentVariables: readonly string[];
}

export interface VercelBlobStore {
  readonly id: string;
  readonly name: string;
  readonly access: "public" | "private";
  readonly region: string | undefined;
  readonly connections: readonly VercelBlobStoreConnection[];
}

export interface VercelProjectEnv {
  readonly id: string;
  readonly key: string;
  readonly target: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOf = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];

const toProject = (value: unknown): VercelProject => {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("Vercel returned a project without an ID.");
  }
  const targets = isRecord(value.targets) ? value.targets : {};
  const production = isRecord(targets.production) ? targets.production : {};
  return {
    id: value.id,
    name: stringOf(value.name) ?? value.id,
    productionAliases: stringsOf(production.alias),
  };
};

const toBlobStore = (value: Record<string, unknown>): VercelBlobStore => ({
  id: String(value.id),
  name: stringOf(value.name) ?? String(value.id),
  access: value.access === "public" ? "public" : "private",
  region: stringOf(value.region),
  connections: (Array.isArray(value.projectsMetadata)
    ? value.projectsMetadata
    : []
  ).flatMap((connection) =>
    isRecord(connection) && typeof connection.projectId === "string"
      ? [
          {
            id: String(connection.id),
            projectId: connection.projectId,
            environments: stringsOf(connection.environments),
            environmentVariables: stringsOf(connection.environmentVariables),
          },
        ]
      : [],
  ),
});

/**
 * The Vercel REST API calls init makes, as the given token and in the given
 * team. Every failure throws a VercelApiError with Vercel's message.
 */
export const createVercelApi = ({
  token,
  teamId,
  fetch: fetchImpl = fetch,
}: {
  readonly token: string;
  readonly teamId?: string;
  readonly fetch?: typeof fetch;
}) => {
  const request = async (
    method: string,
    pathname: string,
    {
      body,
      query = {},
    }: { body?: unknown; query?: Record<string, string> } = {},
  ): Promise<unknown> => {
    const url = new URL(pathname, VERCEL_API_URL);
    for (const [name, value] of Object.entries({
      ...(teamId === undefined ? {} : { teamId }),
      ...query,
    })) {
      url.searchParams.set(name, value);
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const error =
        isRecord(json) && isRecord(json.error) ? json.error : undefined;
      throw new VercelApiError(
        response.status,
        stringOf(error?.code),
        `Vercel API ${method} ${url.pathname} failed (${response.status}): ${
          stringOf(error?.message) ?? (text || response.statusText)
        }`,
      );
    }
    return json;
  };

  /**
   * Every item of a paginated list: Vercel answers a page with
   * `pagination.next`, which the next request passes as `until`.
   */
  const paginate = async (
    pathname: string,
    key: string,
  ): Promise<unknown[]> => {
    const items: unknown[] = [];
    let until: string | undefined;
    do {
      const page = await request("GET", pathname, {
        query: { limit: "100", ...(until ? { until } : {}) },
      });
      const list = isRecord(page) ? page[key] : undefined;
      if (Array.isArray(list)) items.push(...list);
      const pagination =
        isRecord(page) && isRecord(page.pagination) ? page.pagination : {};
      until =
        typeof pagination.next === "number" ||
        typeof pagination.next === "string"
          ? String(pagination.next)
          : undefined;
    } while (until !== undefined);
    return items;
  };

  return {
    async getUser(): Promise<VercelUser> {
      const body = await request("GET", "/v2/user");
      const user = isRecord(body) && isRecord(body.user) ? body.user : {};
      if (typeof user.id !== "string") {
        throw new Error("Vercel returned no user for the token.");
      }
      return {
        id: user.id,
        username: stringOf(user.username) ?? user.id,
        teamsOnly:
          typeof user.defaultTeamId === "string" ||
          user.version === "northstar",
      };
    },

    async listTeams(): Promise<VercelTeam[]> {
      return (await paginate("/v2/teams", "teams")).flatMap((team) =>
        isRecord(team) && typeof team.id === "string"
          ? [
              {
                id: team.id,
                name: stringOf(team.name) ?? team.id,
                slug: stringOf(team.slug) ?? team.id,
              },
            ]
          : [],
      );
    },

    /** The project with this name or ID; undefined when the team has none. */
    async getProject(idOrName: string): Promise<VercelProject | undefined> {
      try {
        return toProject(
          await request("GET", `/v9/projects/${encodeURIComponent(idOrName)}`),
        );
      } catch (error) {
        if (error instanceof VercelApiError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    },

    /** A project with no framework and no build step: init deploys a prebuilt Function. */
    async createProject(name: string): Promise<VercelProject> {
      return toProject(
        await request("POST", "/v11/projects", {
          body: { name, framework: null },
        }),
      );
    },

    /** Whether the project has served a production deployment. */
    async hasProductionDeployment(projectId: string): Promise<boolean> {
      const page = await request("GET", "/v6/deployments", {
        query: { projectId, target: "production", limit: "1" },
      });
      return (
        isRecord(page) &&
        Array.isArray(page.deployments) &&
        page.deployments.length > 0
      );
    },

    async listBlobStores(): Promise<VercelBlobStore[]> {
      const stores = await paginate("/v1/storage/stores", "stores");
      return stores.flatMap((store) =>
        isRecord(store) && store.type === "blob" && typeof store.id === "string"
          ? [toBlobStore(store)]
          : [],
      );
    },

    async createBlobStore(input: {
      readonly name: string;
      readonly access: "public" | "private";
    }): Promise<{ readonly id: string }> {
      const created = await request("POST", "/v1/storage/stores/blob", {
        body: input,
      });
      const store =
        isRecord(created) && isRecord(created.store) ? created.store : {};
      if (typeof store.id !== "string") {
        throw new Error("Vercel created a Blob store without an ID.");
      }
      return { id: store.id };
    },

    /**
     * Connects the store to the project's production environment. Vercel
     * adds `<envVarPrefix>_READ_WRITE_TOKEN` to the project.
     */
    async connectBlobStore(input: {
      readonly storeId: string;
      readonly projectId: string;
      readonly envVarPrefix: string;
    }): Promise<void> {
      await request(
        "POST",
        `/v1/storage/stores/${encodeURIComponent(input.storeId)}/connections`,
        {
          body: {
            projectId: input.projectId,
            envVarEnvironments: ["production"],
            envVarPrefix: input.envVarPrefix,
          },
        },
      );
    },

    /** Removes a store's connection, and the variables it added, from a project. */
    async disconnectBlobStore(
      storeId: string,
      connectionId: string,
    ): Promise<void> {
      await request(
        "DELETE",
        `/v1/storage/stores/${encodeURIComponent(storeId)}/connections/${encodeURIComponent(connectionId)}`,
      );
    },

    async listProjectEnv(projectId: string): Promise<VercelProjectEnv[]> {
      const envs = await paginate(
        `/v10/projects/${encodeURIComponent(projectId)}/env`,
        "envs",
      );
      return envs.flatMap((env) =>
        isRecord(env) &&
        typeof env.id === "string" &&
        typeof env.key === "string"
          ? [{ id: env.id, key: env.key, target: stringsOf(env.target) }]
          : [],
      );
    },

    /** The decrypted value of a project environment variable. */
    async getProjectEnvValue(
      projectId: string,
      envId: string,
    ): Promise<string | undefined> {
      const env = await request(
        "GET",
        `/v1/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
      );
      return isRecord(env) ? stringOf(env.value) : undefined;
    },

    /** Creates or replaces an encrypted production environment variable. */
    async setProductionEnv(
      projectId: string,
      key: string,
      value: string,
    ): Promise<void> {
      await request(
        "POST",
        `/v10/projects/${encodeURIComponent(projectId)}/env`,
        {
          body: { key, value, type: "encrypted", target: ["production"] },
          query: { upsert: "true" },
        },
      );
    },
  };
};

export type VercelApi = ReturnType<typeof createVercelApi>;
