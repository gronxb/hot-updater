import { isRemoteDatabase } from "@hot-updater/plugin-core";

import type { AssembledServer } from "./assembleServer";

type Fetch = typeof fetch;

/** The one route that turns release catalog partitioning on, on both mounts. */
export const PARTITIONING_ROUTE = "/release-catalog-partitioning";

/** The command a person runs to turn partitioning on, after every server runs 1.2.0. */
export const partitionCatalogsCommand = (serverUrl?: string): string =>
  serverUrl === undefined
    ? "npx hot-updater db partition-catalogs"
    : `npx hot-updater db partition-catalogs --server-url ${serverUrl}`;

export type PartitioningEnableErrorCode =
  /** The server answers 404: it runs Hot Updater before 1.2.0. */
  | "SERVER_TOO_OLD"
  /** The server checked its partitions table and refused. */
  | "REFUSED"
  /** The server didn't take the request token: it reads another database. */
  | "REQUEST_REJECTED"
  /** No server to ask: a direct database and no server URL. */
  | "NO_SERVER"
  /** The request failed or the answer is not the route's. */
  | "FAILED";

/** Partitioning stayed off; `message` says why in one line. */
export class PartitioningEnableError extends Error {
  readonly name = "PartitioningEnableError";

  constructor(
    readonly code: PartitioningEnableErrorCode,
    message: string,
    /** The server's refusal code, for `REFUSED`. */
    readonly serverCode?: string,
  ) {
    super(message);
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/u, "");

const read = async (
  response: Response,
): Promise<{ readonly code?: unknown; readonly error?: unknown; readonly data?: unknown }> =>
  ((await response.json().catch(() => null)) as never) ?? {};

/**
 * Turns release catalog partitioning on through the server, which checks
 * its partitions table with its own credentials first. Over
 * `standaloneRepository`, the admin route at its `baseUrl`. Over the
 * server's own database, a request token is stored through that database
 * and handed to the client route at `serverUrl`, the URL apps check for
 * updates at. Nothing here writes the switch.
 */
export const enableReleaseCatalogPartitioning = async ({
  server,
  serverUrl,
  fetchImpl = fetch,
}: {
  readonly server: Pick<
    AssembledServer,
    "database" | "issueReleaseCatalogPartitioningToken"
  >;
  readonly serverUrl?: string;
  readonly fetchImpl?: Fetch;
}): Promise<{ readonly changed: boolean }> => {
  let response: Response;
  let target: string;
  try {
    if (isRemoteDatabase(server.database)) {
      target = "the server in hot-updater.config.ts";
      response = await server.database.fetchAdmin(PARTITIONING_ROUTE, {
        method: "POST",
      });
    } else {
      if (serverUrl === undefined) {
        throw new PartitioningEnableError(
          "NO_SERVER",
          "Name the server apps check for updates at with --server-url <url>.",
        );
      }
      const issue = server.issueReleaseCatalogPartitioningToken;
      if (issue === undefined) {
        throw new PartitioningEnableError(
          "NO_SERVER",
          "This database can't store a partitioning request.",
        );
      }
      target = trimSlash(serverUrl);
      const token = await issue();
      response = await fetchImpl(`${target}${PARTITIONING_ROUTE}`, {
        method: "POST",
        headers: {
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });
    }
  } catch (error) {
    if (error instanceof PartitioningEnableError) throw error;
    throw new PartitioningEnableError(
      "FAILED",
      `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = await read(response);
  if (response.status === 200) {
    const changed = (body.data as { readonly changed?: unknown } | undefined)
      ?.changed;
    if (typeof changed === "boolean") return { changed };
  }
  if (response.status === 404) {
    throw new PartitioningEnableError(
      "SERVER_TOO_OLD",
      `${target} runs Hot Updater before 1.2.0. Deploy 1.2.0 to every server first.`,
    );
  }
  if (response.status === 403) {
    throw new PartitioningEnableError(
      "REQUEST_REJECTED",
      `${target} didn't accept the request: it doesn't read the database in hot-updater.config.ts.`,
    );
  }
  if (response.status === 409 && typeof body.error === "string") {
    throw new PartitioningEnableError(
      "REFUSED",
      body.error,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  throw new PartitioningEnableError(
    "FAILED",
    `${target} answered HTTP ${response.status}${typeof body.error === "string" ? `: ${body.error}` : ""}.`,
  );
};

/**
 * Asks `/version` at `baseUrl` `probes` times, each past every cache with a
 * fresh query, and returns the versions that answered. A deploy is only
 * done when every answer is the expected version: one old answer means some
 * route still reaches the old server.
 */
export const readServerVersions = async ({
  baseUrl,
  probes = 5,
  fetchImpl = fetch,
}: {
  readonly baseUrl: string;
  readonly probes?: number;
  readonly fetchImpl?: Fetch;
}): Promise<string[]> => {
  const versions: string[] = [];
  for (let probe = 0; probe < probes; probe++) {
    const nonce = `${Date.now().toString(36)}${probe}${Math.random().toString(36).slice(2)}`;
    const response = await fetchImpl(
      `${trimSlash(baseUrl)}/version?hot-updater-check=${nonce}`,
      { headers: { "Cache-Control": "no-cache" } },
    );
    const body = (await response.json().catch(() => null)) as {
      readonly version?: unknown;
    } | null;
    versions.push(
      response.ok && typeof body?.version === "string"
        ? body.version
        : `HTTP ${response.status}`,
    );
  }
  return versions;
};

/** Why a managed init left partitioning off, or that it turned it on. */
export type ManagedPartitioning =
  | { readonly enabled: true; readonly changed: boolean }
  | {
      readonly enabled: false;
      /** One line: what kept it off. */
      readonly reason: string;
      /** The command that turns it on once the reason is gone. */
      readonly command: string;
    };

/**
 * After a managed deploy: turns partitioning on only when the platform has
 * confirmed that the whole deployment is done (`deployed`, the provider's
 * own completion signal for the exact resource apps reach) and every
 * cache-busted `/version` at `serverUrl` answers `expectedVersion`. Without
 * a completion signal, or on any other answer, partitioning stays off and
 * the result carries the command that turns it on later.
 */
export const enablePartitioningAfterDeploy = async ({
  server,
  serverUrl,
  expectedVersion,
  deployed,
  fetchImpl = fetch,
}: {
  readonly server: Pick<
    AssembledServer,
    "database" | "issueReleaseCatalogPartitioningToken"
  >;
  readonly serverUrl: string;
  readonly expectedVersion: string;
  /**
   * The platform's confirmation that every instance serving `serverUrl`
   * runs the new deployment, or why it can't say so. Absent: the platform
   * has no such signal.
   */
  readonly deployed?: () => Promise<true | string>;
  readonly fetchImpl?: Fetch;
}): Promise<ManagedPartitioning> => {
  const off = (reason: string): ManagedPartitioning => ({
    enabled: false,
    reason,
    command: partitionCatalogsCommand(trimSlash(serverUrl)),
  });
  if (deployed === undefined) {
    return off(
      "the platform can't confirm that every server instance runs this release.",
    );
  }
  const confirmed = await deployed().catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  if (confirmed !== true) return off(confirmed);
  const versions = await readServerVersions({
    baseUrl: serverUrl,
    fetchImpl,
  }).catch((error: unknown) => [
    error instanceof Error ? error.message : String(error),
  ]);
  const other = versions.find((version) => version !== expectedVersion);
  if (other !== undefined) {
    return off(
      `${trimSlash(serverUrl)}/version answered ${other}, not ${expectedVersion}.`,
    );
  }
  try {
    const { changed } = await enableReleaseCatalogPartitioning({
      server,
      serverUrl,
      fetchImpl,
    });
    return { enabled: true, changed };
  } catch (error) {
    return off(error instanceof Error ? error.message : String(error));
  }
};
