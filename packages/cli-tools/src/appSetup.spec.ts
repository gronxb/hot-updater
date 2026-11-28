import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { printAppSetup, renderAppSetup } from "./appSetup";
import { ConfigBuilder } from "./ConfigBuilder";
import {
  createHotUpdaterConfigScaffoldFromBuilder,
  writeHotUpdaterConfig,
} from "./hotUpdaterConfig";

const prompts = vi.hoisted(() => ({
  note: vi.fn(),
  message: vi.fn(),
}));

vi.mock("./prompts", () => ({
  p: { note: prompts.note, log: { message: prompts.message } },
}));

const credential = {
  label: "API key",
  header: "x-api-key",
  value: 'key"with-quote',
};

describe("renderAppSetup", () => {
  it("sends the credential in its header", () => {
    const source = renderAppSetup({
      baseURL: "https://example.com/hot-updater",
      credential,
      updateStrategy: "appVersion",
    });

    expect(source).toContain('baseURL: "https://example.com/hot-updater",');
    expect(source).toContain(
      '  requestHeaders: {\n    "x-api-key": "key\\"with-quote",\n  },',
    );
    expect(source).toContain(
      ["// App.tsx", 'import { hotUpdater } from "./src/hotUpdater";'].join(
        "\n",
      ),
    );
    expect(source).toContain(
      'export default hotUpdater.wrap({ updateStrategy: "appVersion" })(App);',
    );
    expect(source).not.toMatch(/HotUpdater\.(?!init\()/);
  });

  it("checks with the strategy it is given, or says to match the config", () => {
    expect(
      renderAppSetup({
        baseURL: "https://example.com",
        updateStrategy: "fingerprint",
      }),
    ).toMatch(
      /\n\/\/ hotUpdater\.checkForUpdate\(\) instead\.\nexport default hotUpdater\.wrap\(\{ updateStrategy: "fingerprint" \}\)\(App\);$/u,
    );
    const unknown = renderAppSetup({
      baseURL: "https://example.com",
      updateStrategy: null,
    });
    expect(unknown).toContain(
      '// Use the updateStrategy hot-updater.config.ts sets.\nexport default hotUpdater.wrap({ updateStrategy: "fingerprint" })(App);',
    );
  });

  it("sends no headers to public client routes", () => {
    const source = renderAppSetup({
      baseURL: "https://example.com",
      updateStrategy: "fingerprint",
    });

    expect(source).toContain(
      '// src/hotUpdater.ts\nimport { HotUpdater } from "@hot-updater/react-native";\n\nexport const hotUpdater = HotUpdater.init({\n  baseURL: "https://example.com",\n});',
    );
    expect(source).not.toContain("requestHeaders");
    expect(source).not.toContain("plugins");
  });

  it("imports and adds the client plugins the server's plugins ask for", () => {
    const source = renderAppSetup({
      baseURL: "https://example.com",
      credential,
      updateStrategy: "fingerprint",
      clientPlugins: [
        { module: "@hot-updater/react-native", name: "insights" },
        { module: "feedback-rn", name: "feedback" },
      ],
    });

    // A built-in plugin joins HotUpdater's import from the SDK.
    expect(source).toContain(
      [
        'import { HotUpdater, insights } from "@hot-updater/react-native";',
        'import { feedback } from "feedback-rn";',
      ].join("\n"),
    );
    expect(source).toContain(
      '    "x-api-key": "key\\"with-quote",\n  },\n  plugins: [insights(), feedback()],\n});',
    );
  });
});

describe("printAppSetup", () => {
  const tempDirs: string[] = [];
  const createProject = async (config?: string) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-app-"));
    tempDirs.push(cwd);
    if (config !== undefined) {
      await fs.writeFile(path.join(cwd, "hot-updater.config.ts"), config);
    }
    return cwd;
  };
  const scaffold = (updateStrategy?: "appVersion" | "fingerprint") =>
    createHotUpdaterConfigScaffoldFromBuilder(
      new ConfigBuilder()
        .setBuildType("bare")
        .setStorage({ imports: [], configString: "storage()" })
        .setDatabase({ imports: [], configString: "database()" })
        .setPlugins({ imports: [], configString: "[]" }),
      updateStrategy === undefined ? {} : { updateStrategy },
    );
  const printedWrap = () =>
    String(prompts.note.mock.calls[0]?.[0]).split("\n").at(-1);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("prints the code and the credential", async () => {
    const cwd = await createProject(`${scaffold().text}\n`);
    printAppSetup({
      baseURL: "https://example.com",
      credential,
      clientPlugins: [],
      cwd,
    });

    expect(prompts.note).toHaveBeenNthCalledWith(
      1,
      renderAppSetup({
        baseURL: "https://example.com",
        credential,
        updateStrategy: "fingerprint",
      }),
    );
    expect(prompts.note).toHaveBeenNthCalledWith(
      2,
      credential.value,
      "API key",
    );
    expect(prompts.message).toHaveBeenCalledWith(
      "Store this API key separately in a secure place.",
    );
  });

  it("prints only the credential without a URL, and only the code without a credential", async () => {
    const cwd = await createProject(`${scaffold().text}\n`);
    printAppSetup({ credential, clientPlugins: [], cwd });
    expect(prompts.note).toHaveBeenCalledOnce();
    expect(prompts.note).toHaveBeenCalledWith(credential.value, "API key");

    vi.clearAllMocks();
    printAppSetup({ baseURL: "https://example.com", clientPlugins: [], cwd });
    expect(prompts.note).toHaveBeenCalledOnce();
    expect(prompts.message).not.toHaveBeenCalled();
  });

  it("checks with the strategy of the config init wrote: fingerprint for a new project", async () => {
    const cwd = await createProject();
    await writeHotUpdaterConfig(
      scaffold(),
      path.join(cwd, "hot-updater.config.ts"),
    );

    printAppSetup({ baseURL: "https://example.com", clientPlugins: [], cwd });

    expect(printedWrap()).toBe(
      'export default hotUpdater.wrap({ updateStrategy: "fingerprint" })(App);',
    );
  });

  it("checks with appVersion when the project chose it", async () => {
    const cwd = await createProject();
    await writeHotUpdaterConfig(
      scaffold("appVersion"),
      path.join(cwd, "hot-updater.config.ts"),
    );

    printAppSetup({ baseURL: "https://example.com", clientPlugins: [], cwd });

    expect(printedWrap()).toBe(
      'export default hotUpdater.wrap({ updateStrategy: "appVersion" })(App);',
    );
  });

  it("checks with appVersion when init merged into a config that sets no strategy", async () => {
    const cwd = await createProject(
      [
        'import { bare } from "@hot-updater/bare";',
        'import { defineConfig } from "hot-updater";',
        "",
        "export default defineConfig({",
        "  build: bare(),",
        "});",
        "",
      ].join("\n"),
    );
    const configPath = path.join(cwd, "hot-updater.config.ts");
    await expect(
      writeHotUpdaterConfig(scaffold(), configPath),
    ).resolves.toEqual({ status: "merged", path: configPath });
    await expect(fs.readFile(configPath, "utf-8")).resolves.not.toContain(
      "updateStrategy",
    );

    printAppSetup({ baseURL: "https://example.com", clientPlugins: [], cwd });

    expect(printedWrap()).toBe(
      'export default hotUpdater.wrap({ updateStrategy: "appVersion" })(App);',
    );
  });
});
