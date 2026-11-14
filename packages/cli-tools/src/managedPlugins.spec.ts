import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigBuilder } from "./ConfigBuilder";
import { InitError } from "./initOptions";
import { getMissingInitProviderInputs } from "./initProvider";
import {
  managedPluginsConfig,
  managedPluginsInput,
  selectManagedPlugins,
} from "./managedPlugins";
import { p } from "./prompts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectManagedPlugins", () => {
  it("runs every plugin without prompts when no selection was saved", async () => {
    const multiselect = vi.spyOn(p, "multiselect");

    await expect(
      selectManagedPlugins({ nonInteractive: true, saved: undefined }),
    ).resolves.toEqual(["insights", "apiKeys", "remoteConfig"]);
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("keeps the saved selection without prompts", async () => {
    await expect(
      selectManagedPlugins({ nonInteractive: true, saved: "remoteConfig" }),
    ).resolves.toEqual(["remoteConfig"]);
    await expect(
      selectManagedPlugins({ nonInteractive: true, saved: "none" }),
    ).resolves.toEqual([]);
  });

  it("refuses a saved selection that names an unknown plugin, naming the input", async () => {
    const error = await selectManagedPlugins({
      nonInteractive: true,
      saved: "insights,analytics",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InitError);
    expect((error as Error).message).toContain(
      'HOT_UPDATER_PLUGINS: Unknown managed plugin "analytics"',
    );
  });

  it("asks which plugins to run, starting from the saved selection", async () => {
    const multiselect = vi
      .spyOn(p, "multiselect")
      .mockResolvedValue(["remoteConfig", "insights"]);

    await expect(
      selectManagedPlugins({ nonInteractive: false, saved: "apiKeys" }),
    ).resolves.toEqual(["insights", "remoteConfig"]);
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValues: ["apiKeys"],
        required: false,
        options: [
          expect.objectContaining({ value: "insights" }),
          expect.objectContaining({ value: "apiKeys" }),
          expect.objectContaining({ value: "remoteConfig" }),
        ],
      }),
    );
  });

  it("asks again, from every plugin, when the saved selection can't be read", async () => {
    const warn = vi.spyOn(p.log, "warn").mockImplementation(() => {});
    const multiselect = vi
      .spyOn(p, "multiselect")
      .mockResolvedValue(["insights"]);

    await expect(
      selectManagedPlugins({ nonInteractive: false, saved: "apikeys" }),
    ).resolves.toEqual(["insights"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'HOT_UPDATER_PLUGINS: Unknown managed plugin "apikeys"',
      ),
    );
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValues: ["insights", "apiKeys", "remoteConfig"],
      }),
    );
  });

  it("lets every plugin be switched off", async () => {
    vi.spyOn(p, "multiselect").mockResolvedValue([]);

    await expect(
      selectManagedPlugins({ nonInteractive: false, saved: undefined }),
    ).resolves.toEqual([]);
  });
});

describe("managedPluginsInput", () => {
  it("is optional, so init from an env file needs no selection", () => {
    expect(
      getMissingInitProviderInputs({
        inputs: {},
        provider: { label: "Test", inputs: { plugins: managedPluginsInput } },
      }),
    ).toEqual([]);
  });
});

describe("managedPluginsConfig", () => {
  it("lists every plugin by default, as init always wrote the config", () => {
    expect(managedPluginsConfig()).toEqual({
      imports: [
        {
          pkg: "hot-updater/plugins",
          named: ["apiKeys", "insights", "remoteConfig"],
        },
      ],
      configString: "[apiKeys(), insights(), remoteConfig()]",
    });
  });

  it("lists only the selected plugins and imports only their factories", () => {
    expect(managedPluginsConfig(["remoteConfig", "insights"])).toEqual({
      imports: [
        { pkg: "hot-updater/plugins", named: ["insights", "remoteConfig"] },
      ],
      configString: "[insights(), remoteConfig()]",
    });
  });

  it("writes an empty list without an import when no plugin runs", () => {
    expect(managedPluginsConfig([])).toEqual({
      imports: [],
      configString: "[]",
    });

    const text = new ConfigBuilder()
      .setBuildType("bare")
      .setStorage({ imports: [], configString: "storage()" })
      .setDatabase({ imports: [], configString: "database()" })
      .setPlugins(managedPluginsConfig([]))
      .getResult();
    expect(text).toContain("plugins: [],");
    expect(text).not.toContain("hot-updater/plugins");
  });
});
