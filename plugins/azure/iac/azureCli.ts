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

/** Whether `error` is the CLI's answer for a resource that does not exist. */
export const isNotFound = (error: unknown) =>
  error instanceof Error &&
  /\b(ResourceNotFound|ResourceGroupNotFound|NotFound|could not be found|was not found)\b/i.test(
    error.message,
  );

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

export const isAzureCliInstalled = async () => {
  try {
    await execa("az", ["version", "--output", "json"]);
    return true;
  } catch {
    return false;
  }
};

export interface AzureSubscription {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: string;
}

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

/** Physical regions that host Flex Consumption, by name. */
export const listLocations = async (
  az: AzureCli,
): Promise<readonly AzureLocation[]> => {
  const flex = await listFlexConsumptionLocations(az);
  return ((await az<AzureLocation[]>(["account", "list-locations"])) ?? [])
    .filter(
      (location) =>
        location.metadata?.regionType === "Physical" &&
        flex.has(normalizeLocation(location.name)),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
};
