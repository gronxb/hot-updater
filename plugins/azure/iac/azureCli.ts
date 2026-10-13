import { InitError } from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

/** Runs `az` with JSON output and parses it; `null` for an empty answer. */
export type AzureCli = <T = unknown>(
  args: readonly string[],
) => Promise<T | null>;

const outputOf = (error: unknown) => {
  if (error instanceof ExecaError) {
    const text = String(error.stderr || error.stdout || "").trim();
    if (text) return text;
  }
  return error instanceof Error ? error.message : String(error);
};

/** The `az` CLI, every command scoped to `subscription` once it is known. */
export const createAzureCli =
  (subscription?: string): AzureCli =>
  async <T>(args: readonly string[]) => {
    try {
      const { stdout } = await execa("az", [
        ...args,
        // `az rest` too: its URL names the subscription, but the token comes
        // from the tenant of the one `--subscription` selects.
        ...(subscription === undefined ? [] : ["--subscription", subscription]),
        "--only-show-errors",
        "--output",
        "json",
      ]);
      const text = stdout.trim();
      return text ? (JSON.parse(text) as T) : null;
    } catch (error) {
      throw new InitError(
        `az ${args.slice(0, 3).join(" ")} failed: ${outputOf(error)}`,
      );
    }
  };

/**
 * The `az cosmosdb create` arguments for a serverless account. The core CLI
 * calls a stable API version, which takes the `EnableServerless`
 * capability; the cosmosdb-preview extension replaces the command with one
 * on a preview API version that refuses it and takes `--capacity-mode`.
 */
export const cosmosServerlessArgs = async (): Promise<readonly string[]> => {
  const { stdout } = await execa("az", ["cosmosdb", "create", "--help"], {
    reject: false,
  });
  return stdout.includes("--capacity-mode")
    ? ["--capacity-mode", "Serverless"]
    : ["--capabilities", "EnableServerless"];
};

/** Whether `error` is the CLI's answer for a resource that does not exist. */
export const isNotFound = (error: unknown) =>
  error instanceof Error &&
  /NotFound|Not Found|could not be found|was not found|can ?not find/i.test(
    error.message,
  );

/**
 * The resource providers init's resources need; a new subscription registers
 * none. The CLI requires Microsoft.App to create a Flex Consumption app,
 * whose virtual network integration delegates a subnet to it.
 */
export const AZURE_RESOURCE_PROVIDERS = [
  "Microsoft.Storage",
  "Microsoft.DocumentDB",
  "Microsoft.Web",
  "Microsoft.App",
] as const;

/** Registers the resource providers a subscription has not, waiting for each. */
export const ensureResourceProviders = async (az: AzureCli) => {
  for (const namespace of AZURE_RESOURCE_PROVIDERS) {
    const provider = await az<{ registrationState?: string }>([
      "provider",
      "show",
      "--namespace",
      namespace,
    ]);
    if (provider?.registrationState !== "Registered") {
      await az(["provider", "register", "--namespace", namespace, "--wait"]);
    }
  }
};

/** `az` the resource reads, or `null` when it does not exist. */
export const showOrNull = async <T>(
  az: AzureCli,
  args: readonly string[],
): Promise<T | null> => {
  try {
    return await az<T>(args);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

/** The oldest Azure CLI with the Flex Consumption commands init runs. */
export const MIN_AZURE_CLI_VERSION = "2.60.0";

/** Whether `version` is at least `minimum`, both dotted numbers. */
export const isAtLeastVersion = (version: string, minimum: string) => {
  const parts = (text: string) =>
    text.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [have, need] = [parts(version), parts(minimum)];
  for (let at = 0; at < Math.max(have.length, need.length); at += 1) {
    const difference = (have[at] ?? 0) - (need[at] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

/** The installed Azure CLI's version, or null when `az` is missing. */
export const azureCliVersion = async (): Promise<string | null> => {
  try {
    const { stdout } = await execa("az", ["version", "--output", "json"]);
    const version = (JSON.parse(stdout) as Record<string, unknown>)[
      "azure-cli"
    ];
    return typeof version === "string" ? version : "0";
  } catch {
    return null;
  }
};

export interface AzureSubscription {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: string;
  readonly tenantId?: string;
  readonly tenantDefaultDomain?: string;
  readonly tenantDisplayName?: string;
  readonly user?: { readonly name?: string };
}

/** Where a subscription lives and who signed in to it, to tell same-named ones apart. */
export const describeSubscription = (subscription: AzureSubscription) =>
  [
    subscription.id,
    subscription.tenantDefaultDomain ??
      subscription.tenantDisplayName ??
      subscription.tenantId,
    subscription.user?.name,
  ]
    .filter(Boolean)
    .join(" · ");

export interface AzureLocation {
  readonly name: string;
  readonly displayName: string;
  readonly metadata?: { readonly regionType?: string };
}

/** The subscriptions the signed-in account can use; it signs in first when it must. */
export const listSubscriptions = async (
  nonInteractive: boolean,
): Promise<readonly AzureSubscription[]> => {
  const az = createAzureCli();
  const list = async () =>
    ((await az<AzureSubscription[]>(["account", "list"])) ?? []).filter(
      (subscription) => subscription.state === "Enabled",
    );
  let subscriptions: readonly AzureSubscription[] = [];
  try {
    subscriptions = await list();
  } catch {
    // Not signed in yet.
  }
  if (subscriptions.length > 0) return subscriptions;
  if (nonInteractive) {
    throw new InitError(
      "The Azure CLI is not signed in. Run `az login` (or sign in a service principal), then rerun init.",
    );
  }
  await execa("az", ["login", "--only-show-errors", "--output", "none"], {
    stdio: "inherit",
  });
  subscriptions = await list();
  if (subscriptions.length === 0) {
    throw new InitError("The Azure account has no enabled subscription.");
  }
  return subscriptions;
};

/** A region's name as `az` takes it: `East US` and `eastus` are both `eastus`. */
export const normalizeLocation = (location: string) =>
  location.toLowerCase().replaceAll(" ", "");

/** The regions that host Flex Consumption Function Apps, by normalized name. */
export const listFlexConsumptionLocations = async (
  az: AzureCli,
): Promise<ReadonlySet<string>> =>
  new Set(
    (
      (await az<{ name: string }[]>([
        "functionapp",
        "list-flexconsumption-locations",
      ])) ?? []
    ).map(({ name }) => normalizeLocation(name)),
  );

/**
 * The subscription's physical regions that host Flex Consumption, by name.
 * `az account list-locations` lists the CLI's current subscription's, so
 * the subscription's own list comes over REST.
 */
export const listLocations = async (
  az: AzureCli,
  subscriptionId: string,
): Promise<readonly AzureLocation[]> => {
  const flex = await listFlexConsumptionLocations(az);
  const locations = await az<{ value?: AzureLocation[] }>([
    "rest",
    "--method",
    "get",
    "--url",
    `https://management.azure.com/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`,
  ]);
  return (locations?.value ?? [])
    .filter(
      (location) =>
        location.metadata?.regionType === "Physical" &&
        flex.has(normalizeLocation(location.name)),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
};
