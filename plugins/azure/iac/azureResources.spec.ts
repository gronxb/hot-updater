import fs from "fs/promises";
import os from "os";
import path from "path";

import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import type { AzureCli } from "./azureCli";
import {
  assertCosmosAccountCanInitialize,
  assertFunctionAppCanInitialize,
  AZURE_FUNCTION_PACKAGE,
  createResourceGroup,
  deployFunction,
  ensureCosmosAccount,
  ensureFunctionApp,
  resolveResourceGroup,
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

describe("Azure CLI version", () => {
  it("needs 2.60.0 or later for Flex Consumption", async () => {
    const { isAtLeastVersion, MIN_AZURE_CLI_VERSION } =
      await import("./azureCli");
    expect(isAtLeastVersion("2.91.0", MIN_AZURE_CLI_VERSION)).toBe(true);
    expect(isAtLeastVersion("2.60.0", MIN_AZURE_CLI_VERSION)).toBe(true);
    expect(isAtLeastVersion("2.59.9", MIN_AZURE_CLI_VERSION)).toBe(false);
    expect(isAtLeastVersion("2.9.0", MIN_AZURE_CLI_VERSION)).toBe(false);
    expect(isAtLeastVersion("3.0", MIN_AZURE_CLI_VERSION)).toBe(true);
  });
});

describe("resolveResourceGroup", () => {
  it("reuses an existing group's region without asking", async () => {
    const { az } = fakeAz({ "group show": { location: "koreacentral" } });
    const location = vi.fn();
    await expect(resolveResourceGroup(az, "rg", location)).resolves.toEqual({
      location: "koreacentral",
      exists: true,
    });
    expect(location).not.toHaveBeenCalled();
  });

  it("asks a missing group's region and leaves creating it to after the preflights", async () => {
    const { az, calls } = fakeAz({ "group show": notFound() });
    await expect(
      resolveResourceGroup(az, "rg", async () => "eastus"),
    ).resolves.toEqual({ location: "eastus", exists: false });
    expect(calls.some((args) => args[1] === "create")).toBe(false);

    await createResourceGroup(az, "rg", "eastus");
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

describe("assertStorageAccountCanInitialize", () => {
  it.each([
    ["public network access disabled", { publicNetworkAccess: "Disabled" }],
    [
      "a firewall that denies by default",
      { networkRuleSet: { defaultAction: "Deny" } },
    ],
  ])("refuses an account with %s", async (_, network) => {
    const { assertStorageAccountCanInitialize } =
      await import("./azureResources");
    const { az } = fakeAz({
      "storage account show": { kind: "StorageV2", ...network },
    });
    await expect(
      assertStorageAccountCanInitialize({
        az,
        name: "storage",
        resourceGroup: "rg",
      }),
    ).rejects.toThrow("restricts network access");
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
    inspect: async () => {},
  };

  it("creates a serverless NoSQL account with strong consistency, and returns its primary connection string", async () => {
    const { az, calls } = fakeAz({
      "cosmosdb show": notFound(),
      "cosmosdb check-name-exists": false,
      "cosmosdb keys list": keys,
    });
    await expect(
      ensureCosmosAccount({
        az,
        ...input,
        serverless: async () => ["--capabilities", "EnableServerless"],
      }),
    ).resolves.toBe("AccountEndpoint=https://primary/;AccountKey=p;");
    const create = calls.find((args) => args[1] === "create")!;
    expect(create).toEqual(
      expect.arrayContaining([
        "GlobalDocumentDB",
        "--capabilities",
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

  it.each([
    ["public network access disabled", { publicNetworkAccess: "Disabled" }],
    [
      "an IP firewall without Azure datacenters",
      { ipRules: [{ ipAddressOrRange: "203.0.113.4" }] },
    ],
    ["virtual network rules only", { isVirtualNetworkFilterEnabled: true }],
  ])("refuses an account with %s", async (_, network) => {
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "GlobalDocumentDB",
        consistencyPolicy: { defaultConsistencyLevel: "Strong" },
        ...network,
      },
    });
    await expect(ensureCosmosAccount({ az, ...input })).rejects.toThrow(
      "restricts network access",
    );
  });

  it("accepts a firewall that admits Azure datacenters and this machine", async () => {
    const inspect = vi.fn(async () => {});
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "GlobalDocumentDB",
        consistencyPolicy: { defaultConsistencyLevel: "Strong" },
        ipRules: [
          { ipAddressOrRange: "203.0.113.4" },
          { ipAddressOrRange: "0.0.0.0" },
        ],
      },
      "cosmosdb keys list": keys,
    });
    await expect(ensureCosmosAccount({ az, ...input, inspect })).resolves.toBe(
      "AccountEndpoint=https://primary/;AccountKey=p;",
    );
    expect(inspect).toHaveBeenCalledWith(
      "AccountEndpoint=https://primary/;AccountKey=p;",
    );
  });

  it.each([
    [
      "a firewall that admits Azure datacenters but not this machine",
      Object.assign(new Error("Request originated from IP 198.51.100.7"), {
        code: 403,
      }),
      "refuses this machine",
    ],
    [
      "a container the migration cannot adopt",
      new Error(
        'Cosmos DB container hot_updater_v1 holds storage engine "9"; this version writes "1".',
      ),
      'holds storage engine "9"',
    ],
  ])(
    "refuses an account with %s before anything is created or strengthened",
    async (_, failure, message) => {
      const confirmStrong = vi.fn(async () => true);
      const { az, calls } = fakeAz({
        "cosmosdb show": {
          kind: "GlobalDocumentDB",
          consistencyPolicy: { defaultConsistencyLevel: "Session" },
          ipRules: [{ ipAddressOrRange: "0.0.0.0" }],
        },
        "cosmosdb keys list": keys,
      });
      await expect(
        assertCosmosAccountCanInitialize({
          az,
          name: input.name,
          resourceGroup: input.resourceGroup,
          confirmStrong,
          inspect: async () => {
            throw failure;
          },
        }),
      ).rejects.toThrow(message);
      expect(confirmStrong).not.toHaveBeenCalled();
      expect(
        calls.every((args) => args[1] !== "create" && args[1] !== "update"),
      ).toBe(true);
    },
  );

  it("refuses an account that disables key authentication", async () => {
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "GlobalDocumentDB",
        disableLocalAuth: true,
        consistencyPolicy: { defaultConsistencyLevel: "Strong" },
      },
    });
    await expect(ensureCosmosAccount({ az, ...input })).rejects.toThrow(
      "disables key authentication",
    );
  });

  it("refuses an account that blocks key-based database and container changes", async () => {
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "GlobalDocumentDB",
        disableKeyBasedMetadataWriteAccess: true,
        consistencyPolicy: { defaultConsistencyLevel: "Strong" },
      },
    });
    await expect(ensureCosmosAccount({ az, ...input })).rejects.toThrow(
      "blocks database and container changes with its keys",
    );
  });

  it("refuses a multi-region-write account before asking to strengthen it", async () => {
    const confirmStrong = vi.fn(async () => true);
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "GlobalDocumentDB",
        enableMultipleWriteLocations: true,
        consistencyPolicy: { defaultConsistencyLevel: "Session" },
      },
      "cosmosdb keys list": keys,
    });
    await expect(
      ensureCosmosAccount({ az, ...input, confirmStrong }),
    ).rejects.toThrow("writes in several regions");
    expect(confirmStrong).not.toHaveBeenCalled();
  });

  it("changes an existing account to strong consistency only when allowed", async () => {
    const session = {
      kind: "GlobalDocumentDB",
      consistencyPolicy: { defaultConsistencyLevel: "Session" },
    };
    const refused = fakeAz({
      "cosmosdb show": session,
      "cosmosdb keys list": keys,
    });
    await expect(
      ensureCosmosAccount({ az: refused.az, ...input }),
    ).rejects.toThrow("strong consistency");
    expect(refused.calls.some((args) => args[1] === "update")).toBe(false);

    const allowed = fakeAz({
      "cosmosdb show": session,
      "cosmosdb keys list": keys,
    });
    await assertCosmosAccountCanInitialize({
      az: allowed.az,
      ...input,
      confirmStrong: async () => true,
    });
    expect(allowed.calls.find((args) => args[1] === "update")).toEqual(
      expect.arrayContaining(["--default-consistency-level", "Strong"]),
    );
  });

  it("fails the preflight when Azure refuses strong consistency", async () => {
    const { az } = fakeAz({
      "cosmosdb show": {
        kind: "GlobalDocumentDB",
        consistencyPolicy: { defaultConsistencyLevel: "Session" },
      },
      "cosmosdb keys list": keys,
      "cosmosdb update": () => {
        throw new Error(
          "Strong consistency is not allowed for regions more than 5000 miles apart",
        );
      },
    });
    await expect(
      assertCosmosAccountCanInitialize({
        az,
        ...input,
        confirmStrong: async () => true,
      }),
    ).rejects.toThrow("could not change to strong consistency");
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

  it("reads a Flex Consumption app's fields under properties", async () => {
    const { az } = fakeAz({
      "functionapp show": {
        name: "app",
        properties: {
          defaultHostName: "app.azurewebsites.net",
          functionAppConfig: { runtime: { name: "node", version: "22" } },
        },
      },
    });
    await expect(ensureFunctionApp({ az, ...input })).resolves.toBe(
      "https://app.azurewebsites.net",
    );
  });

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

describe("assertFunctionAppCanInitialize", () => {
  const input = { subscriptionId: "sub", name: "app", resourceGroup: "rg" };

  it("refuses a new name another app holds", async () => {
    const { az, calls } = fakeAz({
      "functionapp show": notFound(),
      rest: { nameAvailable: false, message: "Hostname 'app' already exists." },
    });
    await expect(
      assertFunctionAppCanInitialize({ az, ...input }),
    ).rejects.toThrow("Hostname 'app' already exists.");
    expect(calls.at(-1)).toEqual(
      expect.arrayContaining([
        "https://management.azure.com/subscriptions/sub/providers/Microsoft.Web/checknameavailability?api-version=2024-04-01",
      ]),
    );
  });

  it("refuses an existing app that runs another project's functions", async () => {
    const { az } = fakeAz({
      "functionapp show": {
        functionAppConfig: { runtime: { name: "node", version: "22" } },
      },
      "functionapp config appsettings list": [{ name: "OTHER_SETTING" }],
      "functionapp function list": [{ name: "orders" }],
    });
    await expect(
      assertFunctionAppCanInitialize({ az, ...input }),
    ).rejects.toThrow("runs other functions");
  });

  it("takes an existing app with Hot Updater's settings or no functions", async () => {
    for (const answers of [
      {
        "functionapp config appsettings list": [
          { name: "HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING" },
        ],
      },
      {
        "functionapp config appsettings list": [],
        "functionapp function list": [],
      },
    ]) {
      const { az } = fakeAz({
        "functionapp show": {
          functionAppConfig: { runtime: { name: "node", version: "22" } },
        },
        ...answers,
      });
      await expect(
        assertFunctionAppCanInitialize({ az, ...input }),
      ).resolves.toBeUndefined();
    }
  });

  it("accepts a free name and an existing app that runs the Function", async () => {
    const free = fakeAz({
      "functionapp show": notFound(),
      rest: { nameAvailable: true },
    });
    await expect(
      assertFunctionAppCanInitialize({ az: free.az, ...input }),
    ).resolves.toBeUndefined();
    const existing = fakeAz({
      "functionapp show": {
        functionAppConfig: { runtime: { name: "node", version: "22" } },
      },
    });
    await expect(
      assertFunctionAppCanInitialize({ az: existing.az, ...input }),
    ).resolves.toBeUndefined();
    expect(existing.calls.some((args) => args[0] === "rest")).toBe(false);
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
      'connectionString: secret("HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING")',
    );
    expect(text).toContain('containerName: "hot-updater"');
    expect(text).toContain(
      'connectionString: secret("HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING")',
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
    const { az, calls } = fakeAz({
      "functionapp list-flexconsumption-locations": [
        { name: "eastus" },
        { name: "Korea Central" },
      ],
      rest: {
        value: [
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
      },
    });
    expect((await listLocations(az, "sub")).map(({ name }) => name)).toEqual([
      "eastus",
      "koreacentral",
    ]);
    // The selected subscription's regions, not the CLI's current one's.
    expect(calls.find((args) => args[0] === "rest")).toContain(
      "https://management.azure.com/subscriptions/sub/locations?api-version=2022-12-01",
    );
  });
});
