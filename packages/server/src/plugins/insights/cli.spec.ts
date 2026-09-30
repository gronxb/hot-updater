import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { describe, expect, it, vi } from "vitest";

import { createDatabasePluginApis } from "../../assembly/databasePlugins";
import { pluginCommandsOf } from "../../assembly/pluginCli";
import type {
  PluginCommand,
  PluginCommandUi,
  PluginRemoteCommandContext,
} from "../definePlugin";
import { type InsightsCliApi, insightsCli } from "./cli";
import type { InsightsDeletion } from "./deletion";
import { insights } from "./index";
import { createBundleEventRowFixture } from "./testing/fixtures";

const deleteCommand = (): PluginCommand<InsightsCliApi> => {
  const found = insightsCli.commands?.[0]?.commands?.find(
    ({ name }) => name === "delete",
  );
  if (found === undefined) throw new Error("No delete command.");
  return found;
};

/** A UI that keeps what the command writes, unstyled. */
const createUi = () => {
  const messages: string[] = [];
  const printed: string[] = [];
  const ui: PluginCommandUi = {
    block: (heading, lines) => [heading, ...lines].join("\n"),
    kv: (label, value) => `${label}: ${value}`,
    table: () => "",
    id: (value) => value,
    muted: (value) => value,
    success: (value) => value,
    danger: (value) => value,
    warning: (value) => value,
    message: (text) => messages.push(text),
    info: (text) => messages.push(text),
    warn: (text) => messages.push(text),
    print: (text) => printed.push(text),
    confirm: vi.fn(async () => {}),
  };
  return { ui, messages, printed };
};

const batch = (
  installations: number,
  events: number,
  complete: boolean,
): InsightsDeletion => ({ deleted: { installations, events }, complete });

describe("hot-updater insights delete", () => {
  it("is added by insights()", () => {
    expect(
      pluginCommandsOf([insights()]).map(({ plugin, command }) => [
        plugin,
        command.name,
        command.commands?.map(({ name }) => name),
      ]),
    ).toEqual([["insights", "insights", ["delete"]]]);
  });

  it("deletes an installation's events and latest event through the plugin's API", async () => {
    const api = createDatabasePluginApis(
      { name: "memory", adapter: createMemoryAdapter() },
      [insights()],
    ).insights;
    const event = createBundleEventRowFixture("701", Date.now());
    await api.recordEvent(event);
    const { ui, messages } = createUi();

    await deleteCommand().run!({
      api,
      args: {},
      options: { installId: event.install_id, yes: true },
      ui,
    });

    expect(messages[0]).toContain(`Target: installation ${event.install_id}`);
    expect(messages[0]).toContain("Installations: 1");
    expect(messages[0]).toContain("Events: 1");
    await expect(
      api.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([]);
  });

  it("repeats a user's bounded deletion until it completes, and prints JSON", async () => {
    const deleteUser = vi
      .fn<InsightsCliApi["deleteUser"]>()
      .mockResolvedValueOnce(batch(0, 500, false))
      .mockResolvedValueOnce(batch(2, 20, true));
    const api: InsightsCliApi = { deleteInstallation: vi.fn(), deleteUser };
    const { ui, printed } = createUi();

    await deleteCommand().run!({
      api,
      args: {},
      options: { userId: "user-1", json: true },
      ui,
    });

    expect(ui.confirm).toHaveBeenCalledWith(
      "Delete the Insights data of every installation of user user-1? This cannot be undone.",
    );
    expect(deleteUser).toHaveBeenCalledTimes(2);
    expect(deleteUser).toHaveBeenCalledWith("user-1");
    expect(JSON.parse(printed.join(""))).toEqual({
      deleted: { installations: 2, events: 520 },
    });
  });

  it.each([{}, { installId: "i", userId: "u" }])(
    "needs exactly one of --install-id and --user-id (%j)",
    async (options) => {
      const { ui } = createUi();
      await expect(
        deleteCommand().run!({
          api: { deleteInstallation: vi.fn(), deleteUser: vi.fn() },
          args: {},
          options,
          ui,
        }),
      ).rejects.toThrow("Pass exactly one of --install-id and --user-id.");
      expect(ui.confirm).not.toHaveBeenCalled();
    },
  );

  it("gives up after a bounded number of calls", async () => {
    const { ui } = createUi();
    await expect(
      deleteCommand().run!({
        api: {
          deleteInstallation: async () => batch(0, 1, false),
          deleteUser: vi.fn(),
        },
        args: {},
        options: { installId: "busy", yes: true },
        ui,
      }),
    ).rejects.toThrow("still being deleted after 1000 calls");
  });

  describe("against a standaloneRepository server", () => {
    const run = (
      fetchAdmin: PluginRemoteCommandContext["fetchAdmin"],
      options: Readonly<Record<string, unknown>>,
    ) => {
      const { ui, messages } = createUi();
      return {
        messages,
        done: deleteCommand().runRemote!({
          fetchAdmin,
          args: {},
          options: { yes: true, ...options },
          ui,
        }),
      };
    };

    it("repeats the admin DELETE until it completes", async () => {
      const fetchAdmin = vi
        .fn<PluginRemoteCommandContext["fetchAdmin"]>()
        .mockResolvedValueOnce(Response.json(batch(0, 500, false)))
        .mockResolvedValueOnce(Response.json(batch(1, 3, true)));

      const { done, messages } = run(fetchAdmin, { installId: "ios/1 a" });
      await done;

      expect(fetchAdmin).toHaveBeenCalledWith("/installations/ios%2F1%20a", {
        method: "DELETE",
      });
      expect(fetchAdmin).toHaveBeenCalledTimes(2);
      expect(messages[0]).toContain("Events: 503");

      const byUser = vi
        .fn<PluginRemoteCommandContext["fetchAdmin"]>()
        .mockResolvedValue(Response.json(batch(1, 1, true)));
      await run(byUser, { userId: "a&b" }).done;
      expect(byUser).toHaveBeenCalledWith("/installations?userId=a%26b", {
        method: "DELETE",
      });
    });

    it("says when the server cannot delete Insights data", async () => {
      await expect(
        run(async () => new Response(null, { status: 404 }), {
          installId: "i",
        }).done,
      ).rejects.toThrow(
        "it runs no insights(), or an older @hot-updater/server",
      );
      await expect(
        run(
          async () =>
            Response.json({ error: "Service unavailable" }, { status: 503 }),
          { installId: "i" },
        ).done,
      ).rejects.toThrow("Service unavailable");
    });
  });
});
