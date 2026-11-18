import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  assembleServer,
  confirmInitInputPersistence,
  getCwd,
  getHotUpdaterInitInputEnv,
  getInitProviderEnvVars,
  getInitProviderTextPromptValues,
  InitError,
  link,
  makeEnv,
  p,
  printAppSetup,
  provisionClientCredential,
  type ProvisionedClientCredential,
  readHotUpdaterInitEnv,
  readLoadedHotUpdaterEnv,
  resolveInitProviderInputs,
  type RunInitOptions,
  type RunInitResult,
  shouldAutoSelectOnlyInitResource,
  writeHotUpdaterFiles,
} from "@hot-updater/cli-tools";
import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import { postgres } from "@hot-updater/postgres";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";
import { execa } from "execa";

import { getConfigScaffold } from "./configTemplate";
import {
  initProvider as VERCEL_INIT_PROVIDER,
  isPostgresUrl,
  isVercelBlobStoreName,
  isVercelProjectName,
} from "./init/index";
import {
  createVercelApi,
  type VercelApi,
  VercelApiError,
  type VercelBlobStore,
  type VercelProject,
  type VercelUser,
} from "./vercelApi";
import { resolveVercelToken } from "./vercelAuth";
import { copyBlobStore, privateStoreNameFor } from "./vercelBlobMigration";
import {
  assertPostgresCanInitialize,
  migratePostgres,
  moveBlobStoreReferences,
  readHotUpdaterTables,
  referencedBlobStores,
  withPostgresClient,
} from "./vercelDatabase";
import { deployFunction, verifyFunction } from "./vercelFunction";
import {
  assertVercelProjectCanHostFunction,
  productionBaseUrl,
} from "./vercelProject";

const inputs = VERCEL_INIT_PROVIDER.inputs;
/** The Blob connection's env var prefix: Vercel adds `<prefix>_READ_WRITE_TOKEN`. */
const BLOB_ENV_PREFIX = "HOT_UPDATER_VERCEL_BLOB";
const BLOB_TOKEN_ENV = inputs.blobReadWriteToken.envKey;
const DATABASE_URL_ENV = inputs.databaseUrl.envKey;
/** Project env vars a Marketplace Postgres database adds, such as Neon's `DATABASE_URL`. */
const DATABASE_URL_ENV_PATTERN = /(?:^|_)(?:DATABASE_URL|POSTGRES_URL)$/;

const cancelled = <T>(value: T | symbol): value is symbol => p.isCancel(value);

const exitIfCancelled = <T>(value: T | symbol): T => {
  if (cancelled(value)) process.exit(1);
  return value as T;
};

/** Where init creates the project and store: a team, or a personal account. */
interface VercelScope {
  /** The team's ID, or the user's for a personal account. */
  readonly id: string;
  /** The CLI's `--scope`: the team's ID, or the personal account's username. */
  readonly cliScope: string;
  readonly personal: boolean;
}

const personalScope = (user: VercelUser): VercelScope => ({
  cliScope: user.username,
  id: user.id,
  personal: true,
});

const teamScope = (teamId: string): VercelScope => ({
  cliScope: teamId,
  id: teamId,
  personal: false,
});

/**
 * The team, or the personal account of a user Vercel has not moved to
 * teams, that init deploys to.
 */
const selectScope = async (
  api: VercelApi,
  savedId: string | undefined,
  nonInteractive: boolean,
): Promise<VercelScope> => {
  const user = await api.getUser();
  if (nonInteractive && savedId) {
    return savedId === user.id ? personalScope(user) : teamScope(savedId);
  }
  const scopes = [
    ...(user.teamsOnly
      ? []
      : [
          {
            label: `${user.username} (personal account)`,
            scope: personalScope(user),
          },
        ]),
    ...(await api.listTeams()).map((team) => ({
      label: `${team.name} (${team.slug})`,
      scope: teamScope(team.id),
    })),
  ];
  if (scopes.length === 0) {
    throw new InitError("The Vercel account has no team to deploy to.");
  }
  const saved = scopes.find(({ scope }) => scope.id === savedId);
  if (savedId && !saved) {
    p.log.warn("The saved Vercel team was not found. Select a team again.");
  }
  if (
    shouldAutoSelectOnlyInitResource({
      availableResourceCount: scopes.length,
      savedIdentifier: saved?.scope.id,
    })
  ) {
    return scopes[0]!.scope;
  }
  const selected = exitIfCancelled(
    await p.select({
      message: inputs.teamId.prompt.message,
      initialValue: saved?.scope.id ?? scopes[0]?.scope.id,
      options: scopes.map(({ label, scope }) => ({ value: scope.id, label })),
    }),
  );
  return scopes.find(({ scope }) => scope.id === selected)!.scope;
};

const resolveProjectName = async (
  savedName: string | undefined,
  nonInteractive: boolean,
) => {
  if (nonInteractive && savedName) return savedName;
  const prompt = inputs.projectName.prompt;
  return exitIfCancelled(
    await p.text({
      ...getInitProviderTextPromptValues(prompt, savedName),
      message: prompt.message,
      validate: (value) =>
        isVercelProjectName(value)
          ? undefined
          : "Use up to 100 lowercase letters, digits, '.', '_', or '-', without '---'.",
    }),
  );
};

type BlobStoreSelection = (
  | { readonly kind: "existing"; readonly store: VercelBlobStore }
  | { readonly kind: "create"; readonly name: string }
) & {
  /** A saved public store, whose bundles init moves to the selected store. */
  readonly replaces?: VercelBlobStore;
};

/**
 * The private store a saved public store's bundles move to: Hot Updater
 * 1.0.2 and 1.0.3 could create a public store, and bundles now download only
 * through signed URLs, which a public store has no use for. Refuses before
 * any change when that store's name is taken by another public store.
 */
const replacePublicStore = (
  publicStore: VercelBlobStore,
  stores: readonly VercelBlobStore[],
  projectId: string | undefined,
): BlobStoreSelection => {
  const name = privateStoreNameFor(publicStore.name);
  const existing = stores.find((store) => store.name === name);
  // The store an interrupted run created, which init connects to this
  // project as soon as it creates it, and to no other.
  const ours =
    existing?.access === "private" &&
    existing.connections.some(
      (connection) => connection.projectId === projectId,
    ) &&
    existing.connections.every(
      (connection) => connection.projectId === projectId,
    );
  if (existing !== undefined && !ours) {
    throw new InitError(
      `Blob store ${publicStore.name} is public, and init moves its bundles to a private store named ${name}, which is ${existing.access === "public" ? "a public store" : "not connected to this project"}. Delete or rename ${name} in the Vercel dashboard's Storage tab, then rerun init.`,
    );
  }
  p.log.info(
    `Blob store ${publicStore.name} is public. Init copies its bundles to the private store ${name} and serves them from there; ${publicStore.name} itself is not changed.`,
  );
  return existing
    ? { kind: "existing", store: existing, replaces: publicStore }
    : { kind: "create", name, replaces: publicStore };
};

/**
 * The saved private store, or one the user selects or creates. Bundles
 * download only through signed URLs, so a public store is never used: a
 * saved one is replaced by a private store its bundles move to.
 */
const selectBlobStore = async ({
  nonInteractive,
  projectId,
  savedId,
  savedName,
  stores,
}: {
  readonly nonInteractive: boolean;
  /** The project init deploys to, when it exists. */
  readonly projectId?: string;
  readonly savedId?: string;
  readonly savedName?: string;
  readonly stores: readonly VercelBlobStore[];
}): Promise<BlobStoreSelection> => {
  const found =
    stores.find((store) => store.id === savedId) ??
    (savedId === undefined
      ? stores.find((store) => store.name === savedName)
      : undefined);
  if (found?.access === "public") {
    return replacePublicStore(found, stores, projectId);
  }
  const privateStores = stores.filter((store) => store.access === "private");
  const saved = found;
  if (nonInteractive) {
    if (saved) return { kind: "existing", store: saved };
    if (savedName) return { kind: "create", name: savedName };
    throw new InitError(
      `${inputs.blobStoreName.envKey} is required to select the Blob store.`,
    );
  }
  if ((savedId || savedName) && !saved) {
    p.log.warn("The saved Blob store was not found. Select a store again.");
  }
  const createKey = "\0create";
  const selected = exitIfCancelled(
    await p.select({
      message: "Select the Blob store for bundles",
      initialValue: saved?.id ?? privateStores[0]?.id ?? createKey,
      options: [
        ...privateStores.map((store) => ({
          value: store.id,
          label: `${store.name}${store.region ? ` (${store.region})` : ""}`,
        })),
        { value: createKey, label: "Create a new Blob store" },
      ],
    }),
  );
  const store = privateStores.find((candidate) => candidate.id === selected);
  if (store) return { kind: "existing", store };

  const prompt = inputs.blobStoreName.prompt;
  const name = exitIfCancelled(
    await p.text({
      ...getInitProviderTextPromptValues(prompt, savedName),
      message: prompt.message,
      validate: (value) =>
        isVercelBlobStoreName(value)
          ? undefined
          : "Use up to 32 letters, digits, '_', or '-'.",
    }),
  );
  return { kind: "create", name };
};

/** The production value of a project's environment variable `key`. */
const readProductionEnv = async (
  api: VercelApi,
  project: VercelProject,
  key: string | undefined,
) => {
  const env = (await api.listProjectEnv(project.id)).find(
    (candidate) =>
      candidate.key === key && candidate.target.includes("production"),
  );
  return env === undefined
    ? undefined
    : await api.getProjectEnvValue(project.id, env.id);
};

/** The store a read-write token `vercel_blob_rw_<id>_<secret>` belongs to, `store_<id>`. */
const storeIdOfToken = (token: string) => `store_${token.split("_")[3]}`;

/**
 * The store's read-write token: from its connection to the project, which
 * init makes when there is none, with `prefix` for the variable Vercel adds.
 */
const resolveBlobToken = async (
  api: VercelApi,
  project: VercelProject,
  store: VercelBlobStore,
  prefix = BLOB_ENV_PREFIX,
): Promise<string> => {
  const connection = store.connections.find(
    (candidate) => candidate.projectId === project.id,
  );
  let tokenEnv = connection?.environmentVariables.find((name) =>
    name.endsWith("_READ_WRITE_TOKEN"),
  );
  if (connection === undefined) {
    await api.connectBlobStore({
      envVarPrefix: prefix,
      projectId: project.id,
      storeId: store.id,
    });
    tokenEnv = `${prefix}_READ_WRITE_TOKEN`;
  }
  const token = await readProductionEnv(api, project, tokenEnv);
  if (!token?.startsWith("vercel_blob_rw_")) {
    throw new InitError(
      `Blob store ${store.name} is connected to project ${project.name} without a read-write token for production. Reconnect it from the project's Storage tab with a read-write token, then rerun init.`,
    );
  }
  if (storeIdOfToken(token) !== store.id) {
    throw new InitError(
      `The production ${tokenEnv} of project ${project.name} belongs to another Blob store, not ${store.name}. Disconnect that store from the project's Storage tab, then rerun init.`,
    );
  }
  return token;
};

/**
 * The read-write token of a public store whose bundles init moves: from its
 * connection to the project, the token init saved, or a connection init
 * makes for it. Without one, init refuses before it changes anything else.
 */
const readPublicStoreToken = async (
  api: VercelApi,
  project: VercelProject,
  store: VercelBlobStore,
  savedToken: string | undefined,
): Promise<string> => {
  for (const connection of store.connections) {
    if (connection.projectId !== project.id) continue;
    const token = await readProductionEnv(
      api,
      project,
      connection.environmentVariables.find((name) =>
        name.endsWith("_READ_WRITE_TOKEN"),
      ),
    );
    if (
      token?.startsWith("vercel_blob_rw_") &&
      storeIdOfToken(token) === store.id
    ) {
      return token;
    }
  }
  if (savedToken !== undefined && storeIdOfToken(savedToken) === store.id) {
    return savedToken;
  }
  // A store an earlier move disconnected: connected again under a prefix of
  // its own, which the move disconnects once more.
  const prefix = `${BLOB_ENV_PREFIX}_PUBLIC`;
  let token: string | undefined;
  try {
    await api.connectBlobStore({
      envVarPrefix: prefix,
      projectId: project.id,
      storeId: store.id,
    });
    token = await readProductionEnv(api, project, `${prefix}_READ_WRITE_TOKEN`);
  } catch (error) {
    if (!(error instanceof VercelApiError)) throw error;
  }
  if (
    token?.startsWith("vercel_blob_rw_") &&
    storeIdOfToken(token) === store.id
  ) {
    return token;
  }
  throw new InitError(
    `Blob store ${store.name} is public, and init needs its read-write token to move its bundles to a private store. Connect ${store.name} to project ${project.name} in the Vercel dashboard's Storage tab, then rerun init.`,
  );
};

/**
 * Moves the bundles of the saved public store `from` to the private store
 * `to`: copies every object under the same pathname, migrates the database,
 * whose schema fence then stops a CLI of an earlier release from writing a
 * bundle to `from`, then points the database's storage URIs at `to` with the
 * tables locked, copying first what was written since. Last, it disconnects
 * `from` from the project, whose token variable the Function's now takes.
 * `from` keeps its objects. Each step is safe to run again, and a rerun
 * after the URIs moved copies nothing.
 */
const moveBlobStore = async ({
  api,
  databaseUrl,
  from,
  fromToken,
  plugins,
  project,
  to,
  toToken,
}: {
  readonly api: VercelApi;
  readonly databaseUrl: string;
  readonly from: VercelBlobStore;
  readonly fromToken: string | undefined;
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  readonly project: VercelProject;
  readonly to: VercelBlobStore;
  readonly toToken: string;
}) => {
  if (fromToken !== undefined) {
    const copy = () =>
      copyBlobStore({
        from: { name: from.name, token: fromToken },
        to: { token: toToken },
      });
    await p.tasks([
      {
        title: `Copying the bundles of ${from.name} to ${to.name}...`,
        task: async () => {
          const { copied, total } = await copy();
          return `Copied ${copied} of ${total} objects from ${from.name} to ${to.name}`;
        },
      },
      {
        title: "Migrating the PostgreSQL database...",
        task: async () => {
          const version = await migratePostgres(databaseUrl, plugins);
          return `Migrated the PostgreSQL database to ${version}`;
        },
      },
      {
        title: `Pointing the database's bundles at ${to.name}...`,
        task: async () => {
          const moved = await withPostgresClient(databaseUrl, (client) =>
            moveBlobStoreReferences(client, from.id, to.id, async () => {
              await copy();
            }),
          );
          return `Pointed ${moved} storage URIs at ${to.name}`;
        },
      },
    ]);
  }
  // Including a connection init made to read the token.
  const current = (await api.listBlobStores()).find(
    (store) => store.id === from.id,
  );
  for (const connection of current?.connections ?? from.connections) {
    if (connection.projectId !== project.id) continue;
    await api.disconnectBlobStore(from.id, connection.id);
    p.log.info(`Disconnected Blob store ${from.name} from ${project.name}`);
  }
};

/**
 * The Function's HOT_UPDATER_VERCEL_BLOB_READ_WRITE_TOKEN holds the selected
 * store's token: one left from another store is replaced.
 */
const syncFunctionBlobToken = async (
  api: VercelApi,
  project: VercelProject,
  store: VercelBlobStore,
  blobToken: string,
) => {
  const current = (await api.listProjectEnv(project.id)).find(
    (env) => env.key === BLOB_TOKEN_ENV && env.target.includes("production"),
  );
  if (
    current !== undefined &&
    (await api.getProjectEnvValue(project.id, current.id)) === blobToken
  ) {
    return;
  }
  try {
    await api.setProductionEnv(project.id, BLOB_TOKEN_ENV, blobToken);
  } catch (error) {
    if (!(error instanceof VercelApiError)) throw error;
    throw new InitError(
      `Project ${project.name} keeps ${BLOB_TOKEN_ENV} for another Blob store, and Vercel refused to replace it with ${store.name}'s token: ${error.message}\nDisconnect the other store from the project's Storage tab, then rerun init.`,
    );
  }
};

const createNeonDatabase = async ({
  cwd,
  project,
  scope,
  token,
}: {
  readonly cwd: string;
  readonly project: VercelProject;
  readonly scope: VercelScope;
  readonly token: string;
}) => {
  p.log.info(
    "Creating a Neon Postgres database through the Vercel Marketplace. Accept Neon's terms if the Vercel CLI asks.",
  );
  // The Vercel CLI writes the integration's agent skills into its working
  // directory, so it runs in an empty one, linked to the project by env.
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-neon-"));
  const command = execa(
    "vercel",
    [
      "integration",
      "add",
      "neon",
      "--name",
      `${project.name}-db`,
      "--environment",
      "production",
      "--no-env-pull",
      "--scope",
      scope.cliScope,
    ],
    {
      cwd: workDir,
      env: {
        VERCEL_ORG_ID: scope.id,
        VERCEL_PROJECT_ID: project.id,
        VERCEL_TOKEN: token,
      },
      extendEnv: true,
      localDir: cwd,
      preferLocal: true,
      reject: false,
      stdio: "inherit",
    },
  );
  const { exitCode } = await command.finally(() =>
    fs.rm(workDir, { force: true, recursive: true }),
  );
  if (exitCode !== 0) {
    throw new InitError(
      "The Vercel CLI did not create the Neon database. Rerun init and accept Neon's terms when asked, or select a connected database or a connection URL instead.",
    );
  }
};

/** The connection URL of a Postgres database connected to the project, or one the user enters. */
const selectDatabaseUrl = async ({
  api,
  cwd,
  project,
  savedUrl,
  scope,
  token,
}: {
  readonly api: VercelApi;
  readonly cwd: string;
  readonly project: VercelProject;
  readonly savedUrl?: string;
  readonly scope: VercelScope;
  readonly token: string;
}): Promise<string> => {
  const hasSavedUrl = isPostgresUrl(savedUrl);
  // The project's own HOT_UPDATER_VERCEL_DATABASE_URL, which an earlier init
  // set, is offered when no URL was saved locally.
  const listConnected = async () =>
    (await api.listProjectEnv(project.id)).filter(
      (env) =>
        (env.key !== DATABASE_URL_ENV || !hasSavedUrl) &&
        env.target.includes("production") &&
        DATABASE_URL_ENV_PATTERN.test(env.key),
    );
  const readConnected = async (envId: string, key: string) => {
    const value = await api.getProjectEnvValue(project.id, envId);
    if (!isPostgresUrl(value)) {
      throw new InitError(
        `${key} on project ${project.name} is not a readable PostgreSQL URL; Vercel does not reveal sensitive variables. Rerun init and enter the connection URL.`,
      );
    }
    return value as string;
  };

  const connected = await listConnected();
  const savedKey = "\0saved";
  const enterKey = "\0enter";
  const neonKey = "\0neon";
  const selected = exitIfCancelled(
    await p.select({
      message: "Select the PostgreSQL database",
      initialValue: hasSavedUrl ? savedKey : (connected[0]?.id ?? neonKey),
      options: [
        ...(hasSavedUrl
          ? [
              {
                value: savedKey,
                label: `The saved connection URL (${DATABASE_URL_ENV})`,
              },
            ]
          : []),
        ...connected.map((env) => ({
          value: env.id,
          label:
            env.key === DATABASE_URL_ENV
              ? `${env.key} (set on ${project.name} by an earlier init)`
              : `${env.key} (connected to ${project.name})`,
        })),
        {
          value: neonKey,
          label: "Create a Neon database (Vercel Marketplace)",
        },
        { value: enterKey, label: "Enter a PostgreSQL connection URL" },
      ],
    }),
  );

  if (selected === savedKey) return savedUrl as string;
  if (selected === neonKey) {
    const before = new Set(connected.map((env) => env.id));
    await createNeonDatabase({ cwd, project, scope, token });
    const added = (await listConnected()).filter((env) => !before.has(env.id));
    const preferred =
      added.find((env) => env.key === "DATABASE_URL") ??
      added.find((env) => env.key.endsWith("DATABASE_URL")) ??
      added[0];
    if (preferred === undefined) {
      throw new InitError(
        `The new Neon database added no DATABASE_URL to project ${project.name}. Connect it to the project's production environment, then rerun init.`,
      );
    }
    return readConnected(preferred.id, preferred.key);
  }
  const env = connected.find((candidate) => candidate.id === selected);
  if (env) return readConnected(env.id, env.key);

  return exitIfCancelled(
    await p.password({
      message: inputs.databaseUrl.prompt.message,
      validate: (value) =>
        isPostgresUrl(value)
          ? undefined
          : "Enter a postgres:// or postgresql:// URL.",
    }),
  );
};

export const runInit = async ({
  build,
  envFile,
  secretsEnv,
}: RunInitOptions): Promise<RunInitResult> => {
  const cwd = getCwd();
  const nonInteractive = envFile !== undefined;
  const initEnvSources = await readHotUpdaterInitEnv(cwd, envFile, secretsEnv);
  const { managedEnv } = initEnvSources;
  const initInputEnv = getHotUpdaterInitInputEnv(
    initEnvSources,
    nonInteractive,
  );
  // The environment's value first, then the env files', as init's
  // preflight and every other provider read them.
  const saved = resolveInitProviderInputs(
    initInputEnv,
    VERCEL_INIT_PROVIDER,
  ) as Partial<Record<keyof typeof inputs, string>>;

  const token = await resolveVercelToken({
    cwd,
    nonInteractive,
    ...(saved.vercelToken ? { token: saved.vercelToken } : {}),
  });

  const scope = await selectScope(
    createVercelApi({ token }),
    saved.teamId,
    nonInteractive,
  );
  // A personal account's calls take no teamId.
  const api = createVercelApi({
    token,
    ...(scope.personal ? {} : { teamId: scope.id }),
  });

  const projectName = await resolveProjectName(
    saved.projectName,
    nonInteractive,
  );
  // The saved project by its ID, so a project renamed in Vercel is still
  // found; by name when the name changed or nothing was saved.
  const existingProject =
    (saved.projectId && projectName === saved.projectName
      ? await api.getProject(saved.projectId)
      : undefined) ?? (await api.getProject(projectName));
  if (existingProject) {
    await assertVercelProjectCanHostFunction({
      api,
      project: existingProject,
      ...(saved.projectId ? { savedProjectId: saved.projectId } : {}),
    });
  }

  const stores = await api.listBlobStores();
  const storeSelection = await selectBlobStore({
    nonInteractive,
    ...(existingProject ? { projectId: existingProject.id } : {}),
    stores,
    ...(saved.blobStoreId ? { savedId: saved.blobStoreId } : {}),
    ...(saved.blobStoreName ? { savedName: saved.blobStoreName } : {}),
  });

  let databaseUrl = nonInteractive ? saved.databaseUrl : undefined;
  if (nonInteractive && !isPostgresUrl(databaseUrl)) {
    throw new InitError(
      `${DATABASE_URL_ENV} must be a postgres:// or postgresql:// URL.`,
    );
  }

  const project =
    existingProject ??
    (await (async () => {
      const created = await api.createProject(projectName);
      p.log.info(`Created Vercel project: ${created.name}`);
      return created;
    })());

  if (databaseUrl === undefined) {
    databaseUrl = await selectDatabaseUrl({
      api,
      cwd,
      project,
      scope,
      token,
      ...(saved.databaseUrl ? { savedUrl: saved.databaseUrl } : {}),
    });
  }
  // Before any Blob store or deployment change: a database init can reach
  // and may initialize.
  assertPostgresCanInitialize(await readHotUpdaterTables(databaseUrl));
  // Every public store the database still names moves: the saved one, and
  // one whose bundles a deploy that raced an earlier move left behind. Each
  // is read with its token, which init needs before any change.
  const replaces = storeSelection.replaces;
  const referenced = await withPostgresClient(
    databaseUrl,
    referencedBlobStores,
  );
  const sources = stores.filter(
    (candidate) =>
      candidate.access === "public" &&
      (candidate.id === replaces?.id || referenced.has(candidate.id)),
  );
  // The saved one too while the database names none of it yet: a deploy
  // already under way may write to it until the move.
  const sourceTokens = new Map<string, string>();
  for (const source of sources) {
    sourceTokens.set(
      source.id,
      await readPublicStoreToken(
        api,
        project,
        source,
        saved.blobReadWriteToken,
      ),
    );
  }

  let store: VercelBlobStore;
  if (storeSelection.kind === "existing") {
    store = storeSelection.store;
    p.log.info(`Selected Blob store: ${store.name}`);
  } else {
    const { id } = await api.createBlobStore({
      access: "private",
      name: storeSelection.name,
    });
    store = {
      access: "private",
      connections: [],
      id,
      name: storeSelection.name,
      region: undefined,
    };
    p.log.info(`Created Blob store: ${store.name} (private)`);
  }
  // The replaced store's connection holds init's variable prefix until
  // the move disconnects it.
  const blobToken = await resolveBlobToken(
    api,
    project,
    store,
    sources.length === 0 ? BLOB_ENV_PREFIX : `${BLOB_ENV_PREFIX}_PRIVATE`,
  );
  const resolvedInputs = {
    blobReadWriteToken: blobToken,
    blobStoreId: store.id,
    blobStoreName: store.name,
    databaseUrl,
    projectId: project.id,
    projectName: project.name,
    teamId: scope.id,
    ...(saved.vercelToken ? { vercelToken: saved.vercelToken } : {}),
  };
  // Asked before the move, which the Function of the replaced store can't
  // serve until init redeploys it.
  const persistCredentialInputs = await confirmInitInputPersistence({
    existingEnv: managedEnv,
    inputs: resolvedInputs,
    nonInteractive,
    provider: VERCEL_INIT_PROVIDER,
  });
  const plugins = [insights(), apiKeys(), remoteConfig()];
  for (const source of sources) {
    await moveBlobStore({
      api,
      databaseUrl,
      from: source,
      fromToken: sourceTokens.get(source.id),
      plugins,
      project,
      to: store,
      toToken: blobToken,
    });
  }
  // A Blob token .env.hotupdater itself saved was saved with consent: it
  // follows the store, so deploys don't write to the one init no longer
  // uses. One only a team secrets store holds is not the file's to replace.
  const savedBlobToken = (await readLoadedHotUpdaterEnv(cwd))[
    BLOB_TOKEN_ENV
  ]?.trim();
  await makeEnv({
    ...getInitProviderEnvVars({
      includeConsentInputs: persistCredentialInputs,
      inputs: resolvedInputs,
      provider: VERCEL_INIT_PROVIDER,
    }),
    ...(savedBlobToken && savedBlobToken !== blobToken
      ? { [BLOB_TOKEN_ENV]: blobToken }
      : {}),
  });
  // The deployment is on a private store now.
  const retiredKeys = VERCEL_INIT_PROVIDER.retiredInputs
    .map(({ envKey }) => envKey)
    .filter((envKey) => Object.hasOwn(managedEnv, envKey));
  if (retiredKeys.length > 0) {
    await makeEnv({}, undefined, { removeKeys: retiredKeys });
  }

  await p.tasks([
    {
      title: "Migrating the PostgreSQL database...",
      task: async () => {
        const version = await migratePostgres(databaseUrl, plugins);
        return `Migrated the PostgreSQL database to ${version}`;
      },
    },
    {
      title: "Setting the Function's environment variables...",
      task: async () => {
        await api.setProductionEnv(project.id, DATABASE_URL_ENV, databaseUrl);
        await syncFunctionBlobToken(api, project, store, blobToken);
        return "Set the Function's environment variables";
      },
    },
  ]);

  await deployFunction({
    cwd,
    orgId: scope.id,
    projectId: project.id,
    scope: scope.cliScope,
    token,
  });
  const deployedProject = (await api.getProject(project.id)) ?? project;
  const baseURL = productionBaseUrl(deployedProject);
  await verifyFunction(baseURL);
  p.log.success(`Deployed the Hot Updater Function: ${baseURL}`);

  // A deploy that passed the schema fence before the migration may have
  // written a bundle to a moved store since: move it too. One later still
  // is moved by init's next run.
  for (const [sourceId, sourceToken] of sourceTokens) {
    await withPostgresClient(databaseUrl, (client) =>
      moveBlobStoreReferences(client, sourceId, store.id, async () => {
        await copyBlobStore({
          from: { name: sourceId, token: sourceToken },
          to: { token: blobToken },
        });
      }),
    );
  }

  const database = postgres({ connectionString: databaseUrl });
  // The managed server: its plugins over the database init set up, which
  // assembling it neither reads nor writes.
  const server = assembleServer({ database, plugins });
  let credential: ProvisionedClientCredential | undefined;
  try {
    credential = await provisionClientCredential(server, {
      env: initInputEnv,
      name: "Vercel init",
    });
    if (credential !== undefined) {
      await makeEnv({ [credential.env]: credential.value });
    }
  } finally {
    await database.dispose?.();
  }

  p.log.success("Generated '.env.hotupdater' file with Vercel settings.");
  await writeHotUpdaterFiles(getConfigScaffold(build), {
    cwd,
    settings: "Vercel",
  });

  printAppSetup({
    baseURL,
    ...(credential === undefined ? {} : { credential }),
    clientPlugins: server.clientPlugins,
  });

  return {
    nextSteps: [
      ...(sources.length === 0
        ? []
        : [
            `Set ${BLOB_TOKEN_ENV} to ${store.name}'s token wherever deploys read it besides .env.hotupdater, such as CI or a team secrets store: the project's production ${BLOB_TOKEN_ENV} holds it.`,
          ]),
      link(
        "https://hot-updater.dev/docs/managed/vercel#step-3-add-hotupdater-to-your-project",
      ),
    ],
  };
};

// What init asks for and checks before `runInit`.
export { initProvider } from "./init/index";
// The deployment the agent scaffold ships next to the prebuilt Function.
export { VERCEL_FUNCTION_CONFIG } from "./vercelFunction";
