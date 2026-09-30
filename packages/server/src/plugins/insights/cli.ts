import type { RemoteDatabase } from "@hot-updater/plugin-core";

import type { PluginCli, PluginCommandUi } from "../definePlugin";
import type { InsightsDeletion } from "./deletion";

/** The part of the insights() API the CLI uses. */
export interface InsightsCliApi {
  deleteInstallation(installId: string): Promise<InsightsDeletion>;
  deleteUser(userId: string): Promise<InsightsDeletion>;
}

type Target = { readonly installId: string } | { readonly userId: string };

/** Calls one deletion may take before it gives up. */
const MAX_CALLS = 1_000;

const targetOf = (options: Readonly<Record<string, unknown>>): Target => {
  const installId = options["installId"];
  const userId = options["userId"];
  if ((installId === undefined) === (userId === undefined)) {
    throw new Error("Pass exactly one of --install-id and --user-id.");
  }
  return installId === undefined
    ? { userId: String(userId) }
    : { installId: String(installId) };
};

const describeTarget = (target: Target) =>
  "installId" in target
    ? `installation ${target.installId}`
    : `every installation of user ${target.userId}`;

/** Repeats a bounded deletion until nothing is left, summing what it removed. */
const untilComplete = async (
  call: () => Promise<InsightsDeletion>,
): Promise<InsightsDeletion["deleted"]> => {
  const total = { installations: 0, events: 0 };
  for (let calls = 0; calls < MAX_CALLS; calls += 1) {
    const { deleted, complete } = await call();
    total.installations += deleted.installations;
    total.events += deleted.events;
    if (complete) return total;
  }
  throw new Error(
    `Insights data was still being deleted after ${MAX_CALLS} calls; run the command again to finish.`,
  );
};

/** One bounded DELETE on a self-hosted server's admin Insights routes. */
const deleteRemotely =
  (fetchAdmin: RemoteDatabase["fetchAdmin"], target: Target) =>
  async (): Promise<InsightsDeletion> => {
    const path =
      "installId" in target
        ? `/installations/${encodeURIComponent(target.installId)}`
        : `/installations?userId=${encodeURIComponent(target.userId)}`;
    const response = await fetchAdmin(path, { method: "DELETE" });
    // No DELETE route: the server runs no insights(), or predates deletion.
    if (response.status === 404 || response.status === 405) {
      throw new Error(
        "The server cannot delete Insights data: it runs no insights(), or an older @hot-updater/server.",
      );
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        readonly error?: unknown;
      } | null;
      throw new Error(
        typeof body?.error === "string"
          ? body.error
          : `The server answered the deletion with ${response.status}.`,
      );
    }
    return (await response.json()) as InsightsDeletion;
  };

const deleteData = async (
  options: Readonly<Record<string, unknown>>,
  ui: PluginCommandUi,
  callOf: (target: Target) => () => Promise<InsightsDeletion>,
): Promise<void> => {
  const target = targetOf(options);
  if (!options["yes"]) {
    await ui.confirm(
      `Delete the Insights data of ${describeTarget(target)}? This cannot be undone.`,
    );
  }
  const deleted = await untilComplete(callOf(target));
  if (options["json"]) {
    ui.print(JSON.stringify({ deleted }, null, 2));
    return;
  }
  ui.message(
    ui.block("Insights data deleted", [
      ui.kv("Target", describeTarget(target)),
      ui.kv("Installations", String(deleted.installations)),
      ui.kv("Events", String(deleted.events)),
    ]),
  );
  ui.info(
    "Totals and unique-installation estimates hold no identifiers; they age out with Insights retention.",
  );
};

/**
 * `hot-updater insights delete`: one installation's Insights data, or that of
 * every installation whose latest event names a user, through the plugin's
 * API, or a self-hosted server's admin DELETE routes.
 */
export const insightsCli = {
  commands: [
    {
      name: "insights",
      description: "Manage Insights data",
      commands: [
        {
          name: "delete",
          description:
            "Delete one installation's Insights data, or that of every installation whose latest event names a user",
          options: [
            {
              flags: "--install-id <installId>",
              description: "the installation to delete",
            },
            {
              flags: "--user-id <userId>",
              description: "the user whose installations to delete",
            },
            {
              flags: "--json",
              description: "output the deleted counts as JSON",
            },
            { flags: "-y, --yes", description: "skip confirmation prompt" },
          ],
          run: ({ api, options, ui }) =>
            deleteData(
              options,
              ui,
              (target) => () =>
                "installId" in target
                  ? api.deleteInstallation(target.installId)
                  : api.deleteUser(target.userId),
            ),
          runRemote: ({ fetchAdmin, options, ui }) =>
            deleteData(options, ui, (target) =>
              deleteRemotely(fetchAdmin, target),
            ),
        },
      ],
    },
  ],
} satisfies PluginCli<InsightsCliApi>;
