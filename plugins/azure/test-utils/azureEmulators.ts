import { CosmosClient } from "@azure/cosmos";
import {
  assertDockerDaemonAvailable,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
} from "@hot-updater/test-utils/node";

/**
 * A dated emulator release: `vnext-EN20261008` answers a query on a missing
 * container with 400 instead of Azure Cosmos DB's 404, so a moving tag can
 * break the suite without a code change.
 */
const COSMOS_IMAGE =
  "mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-EN20260907";
const AZURITE_IMAGE = "mcr.microsoft.com/azure-storage/azurite:3.37.0";
/** Lowkey Vault, a Key Vault emulator. */
const LOWKEY_VAULT_IMAGE = "nagyesta/lowkey-vault:7.3.112";

/** The emulators' well-known account keys, public and accepted only by them. */
const COSMOS_EMULATOR_KEY =
  "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";
const AZURITE_ACCOUNT = "devstoreaccount1";
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const waitFor = async (
  probe: () => Promise<unknown>,
  runtime: ReturnType<typeof spawnRuntime>,
  name: string,
) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (runtime.child.exitCode !== null) {
      throw new Error(
        `${name} exited early: ${formatRuntimeLogs(runtime.logs)}`,
      );
    }
    try {
      await probe();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `${name} did not start: ${formatRuntimeLogs(runtime.logs)}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

/** The Cosmos DB vNext emulator in Docker: one runtime, a container per case. */
export const startCosmosEmulator = async () => {
  assertDockerDaemonAvailable(
    "Cosmos DB integration specs need a running Docker daemon.",
  );
  const port = await findOpenPort();
  const runtime = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "-p",
      `127.0.0.1:${port}:${port}`,
      COSMOS_IMAGE,
      "--port",
      String(port),
      "--enable-explorer",
      "false",
      "--enable-telemetry",
      "false",
    ],
    cwd: process.cwd(),
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const connectionString = `AccountEndpoint=${endpoint}/;AccountKey=${COSMOS_EMULATOR_KEY};`;
  const client = new CosmosClient({
    endpoint,
    key: COSMOS_EMULATOR_KEY,
    // The emulator advertises `localhost`, which may resolve to another address.
    connectionPolicy: { enableEndpointDiscovery: false },
  });
  await waitFor(
    () => client.databases.readAll().fetchAll(),
    runtime,
    "The Cosmos DB emulator",
  );
  let names = 0;
  return {
    client,
    connectionString,
    /** A fresh database name; a store's migration creates it. */
    databaseId: () => `hot-updater-${process.pid}-${(names += 1)}`,
    dropDatabase: (databaseId: string) =>
      client
        .database(databaseId)
        .delete()
        .then(
          () => undefined,
          () => undefined,
        ),
    stop: async () => {
      client.dispose();
      await stopRuntime(runtime.child);
    },
  };
};

export type CosmosEmulator = Awaited<ReturnType<typeof startCosmosEmulator>>;

/** Azurite's Blob service in Docker. */
export const startAzurite = async () => {
  assertDockerDaemonAvailable(
    "Azure Blob Storage integration specs need a running Docker daemon.",
  );
  const port = await findOpenPort();
  const runtime = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "-p",
      `127.0.0.1:${port}:10000`,
      AZURITE_IMAGE,
      "azurite-blob",
      "--blobHost",
      "0.0.0.0",
      "--inMemoryPersistence",
      "--skipApiVersionCheck",
      "--loose",
    ],
    cwd: process.cwd(),
  });
  const blobEndpoint = `http://127.0.0.1:${port}/${AZURITE_ACCOUNT}`;
  const connectionString = `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};AccountKey=${AZURITE_KEY};BlobEndpoint=${blobEndpoint};`;
  await waitFor(
    async () => {
      const response = await fetch(`${blobEndpoint}?comp=list`);
      // Any answer means the service is up; an unsigned list is refused.
      await response.arrayBuffer();
    },
    runtime,
    "Azurite",
  );
  return {
    connectionString,
    stop: () => stopRuntime(runtime.child),
  };
};

/**
 * Lowkey Vault in Docker, serving one vault on the loopback port it
 * listens on. Its certificate is self-signed, so the caller turns off
 * certificate checks while it runs (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
 */
export const startLowkeyVault = async () => {
  assertDockerDaemonAvailable(
    "Key Vault integration specs need a running Docker daemon.",
  );
  const port = await findOpenPort();
  const runtime = spawnRuntime({
    command: "docker",
    args: [
      "run",
      "--rm",
      "-p",
      `127.0.0.1:${port}:${port}`,
      "-e",
      // The vault's URL must be the one requests name, port included.
      `LOWKEY_ARGS=--server.port=${port}`,
      LOWKEY_VAULT_IMAGE,
    ],
    cwd: process.cwd(),
  });
  const vaultUrl = `https://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      const response = await fetch(`${vaultUrl}/ping`);
      if (!response.ok) throw new Error(`ping answered ${response.status}`);
    },
    runtime,
    "Lowkey Vault",
  );
  return {
    vaultUrl,
    stop: () => stopRuntime(runtime.child),
  };
};
