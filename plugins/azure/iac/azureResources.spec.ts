import fs from "fs/promises";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import type { AzureCli } from "./azureCli";
import {
  AZURE_FUNCTION_PACKAGE,
  deployFunction,
  ensureCosmosAccount,
  ensureFunctionApp,
  ensureResourceGroup,
} from "./azureResources";
import { getConfigScaffold } from "./configTemplate";
import { defaultResourceNames } from "./index";
import {
  isAzureCosmosAccountName,
  isAzureFunctionAppName,
  isAzureResourceGroupName,
  isAzureStorageAccountName,
} from "./init/index";

/** An `az` that answers each command by its first words, recording every call. */
const fakeAz = (
  answers: Record<string, unknown | ((args: readonly string[]) => unknown)>,
) => {
  const calls: (readonly string[])[] = [];
  const az = (async (args: readonly string[]) => {
    calls.push(args);
    const key = Object.keys(answers)
      .filter((prefix) => args.join(" ").startsWith(prefix))
      .sort((left, right) => right.length - left.length)[0];
    if (key === undefined) return null;
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(args) : answer;
  }) as AzureCli;
  return { az, calls };
};

const notFound = () => new Error("az x failed: (ResourceNotFound) not found");

describe("default resource names", () => {
  it("are valid, stable for a subscription and group, and differ across groups", () => {
    const names = defaultResourceNames("sub-1", "hot-updater");
    expect(isAzureStorageAccountName(names.storageAccount)).toBe(true);
    expect(isAzureCosmosAccountName(names.cosmosAccount)).toBe(true);
    expect(isAzureFunctionAppName(names.functionApp)).toBe(true);
    expect(defaultResourceNames("sub-1", "hot-updater")).toEqual(names);
    expect(defaultResourceNames("sub-1", "other")).not.toEqual(names);
  });

  it("validates names as Azure does", () => {
    expect(isAzureResourceGroupName("hot-updater")).toBe(true);
    expect(isAzureResourceGroupName("a")).toBe(true);
    expect(isAzureResourceGroupName("a".repeat(90))).toBe(true);
    expect(isAzureResourceGroupName("a".repeat(91))).toBe(false);
    expect(isAzureResourceGroupName("배포-(rg)_1.x")).toBe(true);
    expect(isAzureResourceGroupName("ends-with-dot.")).toBe(false);
    expect(isAzureResourceGroupName("has space")).toBe(false);
    expect(isAzureStorageAccountName("Upper")).toBe(false);
    expect(isAzureStorageAccountName("a".repeat(25))).toBe(false);
    expect(isAzureCosmosAccountName("-leading")).toBe(false);
    expect(isAzureFunctionAppName("trailing-")).toBe(false);
  });
});

describe("ensureResourceGroup", () => {
  it("reuses an existing group's region without asking", async () => {
    const { az } = fakeAz({ "group show": { location: "koreacentral" } });
    const location = vi.fn();
    await expect(ensureResourceGroup(az, "rg", location)).resolves.toEqual({
      location: "koreacentral",
      created: false,
    });
    expect(location).not.toHaveBeenCalled();
  });

  it("creates a missing group in the region it asks for", async () => {
    const { az, calls } = fakeAz({ "group show": notFound() });
    await expect(
      ensureResourceGroup(az, "rg", async () => "eastus"),
    ).resolves.toEqual({ location: "eastus", created: true });
    expect(calls.at(-1)).toEqual([
      "group",
      "create",
      "--name",
      "rg",
      "--location",
      "eastus",
    ]);
  });
});

describe("ensureStorageAccount", () => {
  it.each(["BlobStorage", "BlockBlobStorage", "FileStorage"])(
    "refuses an existing %s account, which cannot host the Function App",
    async (kind) => {
      const { ensureStorageAccount } = await import("./azureResources");
      const { az, calls } = fakeAz({ "storage account show": { kind } });
      await expect(
        ensureStorageAccount({
          az,
          name: "storage",
          resourceGroup: "rg",
          location: "eastus",
        }),
      ).rejects.toThrow("general-purpose (StorageV2)");
      expect(calls.some((args) => args[2] === "show-connection-string")).toBe(
        false,
      );
    },
  );
});

describe("ensureCosmosAccount", () => {
  const keys = {
    connectionStrings: [
      {
        connectionString: "AccountEndpoint=https://read/;AccountKey=r;",
        description: "Primary Read-Only SQL Connection String",
        keyKind: "PrimaryReadonly",
      },
      {
        connectionString: "AccountEndpoint=https://primary/;AccountKey=p;",
        description: "Primary SQL Connection String",
        keyKind: "Primary",
      },
    ],
  };
  const input = {
    name: "cosmos",
    resourceGroup: "rg",
    location: "eastus",
    confirmStrong: async () => false,
  };

  it("creates a serverless NoSQL account with strong consistency, and returns its primary connection string", async () => {
    const { az, calls } = fakeAz({
      "cosmosdb show": notFound(),
      "cosmosdb check-name-exists": false,
      "cosmosdb keys list": keys,
    });
    await expect(ensureCosmosAccount({ az, ...input })).resolves.toBe(
      "AccountEndpoint=https://primary/;AccountKey=p;",
    );
    const create = calls.find((args) => args[1] === "create")!;
    expect(create).toEqual(
      expect.arrayContaining([
        "GlobalDocumentDB",
        "EnableServerless",
        "Strong",
        "regionName=eastus",
      ]),
    );
  });

  it("refuses an account of another API", async () => {
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "MongoDB",
        capabilities: [{ name: "EnableMongo" }],
      },
    });
    await expect(ensureCosmosAccount({ az, ...input })).rejects.toThrow(
      "not an API for NoSQL account",
    );
  });

  it("changes an existing account to strong consistency only when allowed", async () => {
    const session = {
      kind: "GlobalDocumentDB",
      consistencyPolicy: { defaultConsistencyLevel: "Session" },
    };
    const refused = fakeAz({ "cosmosdb show": session });
    await expect(
      ensureCosmosAccount({ az: refused.az, ...input }),
    ).rejects.toThrow("strong consistency");
    expect(refused.calls.some((args) => args[1] === "update")).toBe(false);

    const allowed = fakeAz({
      "cosmosdb show": session,
      "cosmosdb keys list": keys,
    });
    await ensureCosmosAccount({
      az: allowed.az,
      ...input,
      confirmStrong: async () => true,
    });
    expect(allowed.calls.find((args) => args[1] === "update")).toEqual(
      expect.arrayContaining(["--default-consistency-level", "Strong"]),
    );
  });
});

describe("ensureFunctionApp", () => {
  it("creates a missing app on a Flex Consumption plan with Node.js 22", async () => {
    let created = false;
    const { az, calls } = fakeAz({
      "functionapp show": () => {
        if (!created) throw notFound();
        return { defaultHostName: "app-abc.eastus-01.azurewebsites.net" };
      },
      "functionapp create": () => {
        created = true;
        return {};
      },
    });
    await expect(
      ensureFunctionApp({
        az,
        name: "app",
        resourceGroup: "rg",
        location: "eastus",
        storageAccount: "storage",
      }),
    ).resolves.toBe("https://app-abc.eastus-01.azurewebsites.net");
    expect(calls.find((args) => args[1] === "create")).toEqual(
      expect.arrayContaining([
        "--flexconsumption-location",
        "eastus",
        "--runtime",
        "node",
        "--runtime-version",
        "22",
        "--storage-account",
        "storage",
      ]),
    );
  });
});

describe("ensureFunctionApp with an existing app", () => {
  const input = {
    name: "app",
    resourceGroup: "rg",
    location: "eastus",
    storageAccount: "storage",
  };

  it("reuses a Flex Consumption app on Node.js 22", async () => {
    const { az, calls } = fakeAz({
      "functionapp show": {
        defaultHostName: "app.azurewebsites.net",
        functionAppConfig: { runtime: { name: "node", version: "22" } },
      },
    });
    await expect(ensureFunctionApp({ az, ...input })).resolves.toBe(
      "https://app.azurewebsites.net",
    );
    expect(calls.some((args) => args[1] === "create")).toBe(false);
  });

  it.each([
    [
      "a Python app",
      { functionAppConfig: { runtime: { name: "python", version: "3.11" } } },
    ],
    [
      "an older Node.js app",
      { functionAppConfig: { runtime: { name: "node", version: "20" } } },
    ],
    ["an app on another plan", { functionAppConfig: null }],
  ])("refuses %s before anything deploys to it", async (_, config) => {
    const { az } = fakeAz({
      "functionapp show": {
        defaultHostName: "app.azurewebsites.net",
        ...config,
      },
    });
    await expect(ensureFunctionApp({ az, ...input })).rejects.toThrow(
      "not a Flex Consumption app on Node.js 22",
    );
  });
});

describe("deployFunction", () => {
  it("zips the bundle, host.json, and the package.json that loads it at the archive root", async () => {
    const functionDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-azure-spec-"),
    );
    try {
      await fs.writeFile(path.join(functionDir, "index.mjs"), "export {};\n");
      await fs.writeFile(
        path.join(functionDir, "host.json"),
        '{"version":"2.0","extensions":{"http":{"routePrefix":""}}}',
      );
      let entries: Record<string, string> = {};
      const { az } = fakeAz({
        "functionapp deployment source config-zip": async (
          args: readonly string[],
        ) => {
          const zip = await JSZip.loadAsync(
            await fs.readFile(args[args.indexOf("--src") + 1]!),
          );
          entries = Object.fromEntries(
            await Promise.all(
              Object.keys(zip.files).map(
                async (name) =>
                  [name, await zip.file(name)!.async("string")] as const,
              ),
            ),
          );
        },
      });
      await deployFunction({
        az,
        functionDir,
        name: "app",
        resourceGroup: "rg",
      });
      expect(Object.keys(entries).sort()).toEqual([
        "host.json",
        "index.mjs",
        "package.json",
      ]);
      expect(JSON.parse(entries["package.json"]!)).toEqual(
        AZURE_FUNCTION_PACKAGE,
      );
    } finally {
      await fs.rm(functionDir, { recursive: true, force: true });
    }
  });
});

describe("config scaffold", () => {
  it("configures Blob Storage and Cosmos DB from the saved connection strings, with the managed server's plugins", () => {
    const { text } = getConfigScaffold("bare");
    expect(text).toContain(
      'import { azureBlobStorage, cosmosDatabase } from "@hot-updater/azure";',
    );
    expect(text).toContain(
      "connectionString: process.env.HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING!",
    );
    expect(text).toContain('containerName: "hot-updater"');
    expect(text).toContain(
      "connectionString: process.env.HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING!",
    );
    expect(text).toContain("plugins: [apiKeys(), insights(), remoteConfig()]");
  });
});

describe("config scaffold container", () => {
  it("names the container init creates", async () => {
    const { AZURE_BLOB_V1_CONTAINER } =
      await import("../src/azureInfrastructureNames");
    expect(getConfigScaffold("bare").text).toContain(
      `containerName: "${AZURE_BLOB_V1_CONTAINER}"`,
    );
  });
});

describe("region choices", () => {
  it("offers only physical regions that host Flex Consumption", async () => {
    const { listLocations } = await import("./azureCli");
    const { az } = fakeAz({
      "functionapp list-flexconsumption-locations": [
        { name: "eastus" },
        { name: "Korea Central" },
      ],
      "account list-locations": [
        {
          name: "westus",
          displayName: "West US",
          metadata: { regionType: "Physical" },
        },
        {
          name: "koreacentral",
          displayName: "Korea Central",
          metadata: { regionType: "Physical" },
        },
        {
          name: "eastus",
          displayName: "East US",
          metadata: { regionType: "Physical" },
        },
        {
          name: "eastusstg",
          displayName: "East US (Stage)",
          metadata: { regionType: "Logical" },
        },
      ],
    });
    expect((await listLocations(az)).map(({ name }) => name)).toEqual([
      "eastus",
      "koreacentral",
    ]);
  });
});
