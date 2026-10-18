import fs from "node:fs/promises";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readExpoSettings, recordRequires } from "./expoFingerprint";

let project: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-expo-fp-"));
  const plugin = path.join(project, "node_modules/expo-build-properties");
  await fs.mkdir(plugin, { recursive: true });
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: "expo-build-properties", version: "0.13.2" }),
  );
  await fs.mkdir(path.join(project, "plugins"));
  await fs.writeFile(
    path.join(project, "plugins/withLocal.js"),
    "module.exports = (config) => config;",
  );
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("readExpoSettings", () => {
  it("reads the engine, the architecture, and the config plugins the app declares", () => {
    const settings = readExpoSettings(
      project,
      {
        jsEngine: "hermes",
        newArchEnabled: true,
        android: { jsEngine: "jsc" },
        plugins: [
          ["@hot-updater/expo", { channel: "production" }],
          ["expo-build-properties", { ios: { deploymentTarget: "15.1" } }],
          "./plugins/withLocal",
        ],
      },
      "android",
    );

    expect(settings["expo.jsEngine"]).toBe("jsc");
    expect(settings["expo.newArchEnabled"]).toBe("true");
    // Hot Updater's own plugin writes the channel and key, not the interface.
    expect(
      Object.keys(settings).some((key) => key.includes("@hot-updater")),
    ).toBe(false);
    expect(
      JSON.parse(settings["expo.plugin[0]:expo-build-properties"]!),
    ).toEqual({
      props: { ios: { deploymentTarget: "15.1" } },
      source: "expo-build-properties@0.13.2",
    });
    expect(settings["expo.plugin[1]:./plugins/withLocal"]).toMatch(
      /"source":"sha256:[0-9a-f]{64}"/,
    );
  });

  it("changes with a plugin's options or code, not with its key order", async () => {
    const read = (props: object) =>
      readExpoSettings(
        project,
        { plugins: [["expo-build-properties", props], "./plugins/withLocal"] },
        "ios",
      );
    const before = read({ a: 1, b: 2 });

    expect(read({ b: 2, a: 1 })).toEqual(before);
    expect(read({ a: 1, b: 3 })).not.toEqual(before);
    await fs.writeFile(
      path.join(project, "plugins/withLocal.js"),
      "module.exports = (config) => ({ ...config, name: 'x' });",
    );
    expect(read({ a: 1, b: 2 })).not.toEqual(before);
  });

  it("hashes the files a local plugin imports, as Expo loaded them", async () => {
    await fs.writeFile(
      path.join(project, "plugins/helper.js"),
      "module.exports = 1;",
    );
    await fs.writeFile(
      path.join(project, "plugins/withNative.js"),
      "require('./helper'); module.exports = (config) => config;",
    );
    // Expo requires a plugin while it reads the app config.
    createRequire(path.join(project, "package.json"))("./plugins/withNative");
    const read = () =>
      readExpoSettings(project, { plugins: ["./plugins/withNative"] }, "ios");
    const before = read();

    await fs.writeFile(
      path.join(project, "plugins/helper.js"),
      "module.exports = 2;",
    );
    expect(read()).not.toEqual(before);
  });

  it("hashes the files a function plugin's module imports", async () => {
    await fs.writeFile(
      path.join(project, "plugins/fnHelper.js"),
      "module.exports = 1;",
    );
    await fs.writeFile(
      path.join(project, "plugins/withFn.js"),
      "require('./fnHelper'); module.exports = function withFn(config) { return config; };",
    );
    // app.config.js: plugins: [require("./plugins/withFn")]
    const withFn = createRequire(path.join(project, "package.json"))(
      "./plugins/withFn",
    ) as () => unknown;
    const read = () => readExpoSettings(project, { plugins: [withFn] }, "ios");
    const before = read();

    await fs.writeFile(
      path.join(project, "plugins/fnHelper.js"),
      "module.exports = 2;",
    );
    expect(read()).not.toEqual(before);
  });

  it("hashes a workspace plugin package's files, not just its version", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-ws-"),
    );
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({ name: "@acme/native-plugin", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(workspace, "helper.js"),
        "module.exports = 1;",
      );
      await fs.writeFile(
        path.join(workspace, "app.plugin.js"),
        "require('./helper'); module.exports = (config) => config;",
      );
      await fs.mkdir(path.join(project, "node_modules/@acme"), {
        recursive: true,
      });
      await fs.symlink(
        workspace,
        path.join(project, "node_modules/@acme/native-plugin"),
      );
      // Expo loads the package's app.plugin.js.
      createRequire(path.join(project, "package.json"))(
        "@acme/native-plugin/app.plugin.js",
      );
      const read = () =>
        readExpoSettings(project, { plugins: ["@acme/native-plugin"] }, "ios");
      const before = read();
      expect(before["expo.plugin[0]:@acme/native-plugin"]).toMatch(/sha256:/);

      await fs.writeFile(
        path.join(workspace, "helper.js"),
        "module.exports = 2;",
      );
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("hashes what app.config.js imports for a plugin written inline in it", async () => {
    await fs.writeFile(
      path.join(project, "plugins/inlineHelper.js"),
      "module.exports = 1;",
    );
    await fs.writeFile(path.join(project, "app.config.js"), "");
    const configPath = await fs.realpath(path.join(project, "app.config.js"));
    // Expo evaluates app.config.js from a string, as require-from-string does.
    const config = new Module(configPath) as Module & {
      _compile: (code: string, filename: string) => void;
    };
    config.filename = configPath;
    config.paths = (
      Module as unknown as { _nodeModulePaths: (dir: string) => string[] }
    )._nodeModulePaths(path.dirname(configPath));
    // Loaded earlier by another module, so Node keeps that one as its parent.
    createRequire(path.join(project, "package.json"))("./plugins/inlineHelper");
    await recordRequires(async () =>
      config._compile("require('./plugins/inlineHelper');", configPath),
    );
    const inline = (value: object) => value;
    const read = () =>
      readExpoSettings(project, { plugins: [inline] }, "ios", configPath);
    const before = read();

    await fs.writeFile(
      path.join(project, "plugins/inlineHelper.js"),
      "module.exports = 2;",
    );
    expect(read()).not.toEqual(before);
  });

  it("hashes a sibling workspace package a plugin imports", async () => {
    const sibling = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-sibling-")),
    );
    try {
      await fs.writeFile(path.join(sibling, "index.js"), "module.exports = 1;");
      await fs.writeFile(
        path.join(project, "plugins/withSibling.js"),
        `require(${JSON.stringify(path.join(sibling, "index.js"))}); module.exports = (config) => config;`,
      );
      createRequire(path.join(project, "package.json"))(
        "./plugins/withSibling",
      );
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["./plugins/withSibling"] },
          "ios",
        );
      const before = read();

      await fs.writeFile(path.join(sibling, "index.js"), "module.exports = 2;");
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it("hashes a function plugin a sibling workspace package exports", async () => {
    const sibling = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-fn-sibling-")),
    );
    try {
      await fs.writeFile(
        path.join(sibling, "helper.js"),
        "module.exports = 1;",
      );
      await fs.writeFile(
        path.join(sibling, "index.js"),
        "require('./helper'); module.exports = function withAcme(config) { return config; };",
      );
      // app.config.js: plugins: [require("@acme/native-plugin")]
      const withAcme = createRequire(path.join(project, "package.json"))(
        path.join(sibling, "index.js"),
      ) as () => unknown;
      const read = () =>
        readExpoSettings(project, { plugins: [withAcme] }, "ios");
      const before = read();

      await fs.writeFile(
        path.join(sibling, "helper.js"),
        "module.exports = 2;",
      );
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it("hashes what app.config.js applies directly and the data it reads, but not package.json", async () => {
    await fs.writeFile(
      path.join(project, "plugins/native.json"),
      JSON.stringify({ pod: "A" }),
    );
    await fs.writeFile(
      path.join(project, "plugins/direct.js"),
      "require('./native.json'); module.exports = (c) => c;",
    );
    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    await fs.writeFile(path.join(project, "app.config.js"), "");
    const configPath = await fs.realpath(path.join(project, "app.config.js"));
    const config = new Module(configPath) as Module & {
      _compile: (code: string, filename: string) => void;
    };
    config.filename = configPath;
    config.paths = (
      Module as unknown as { _nodeModulePaths: (dir: string) => string[] }
    )._nodeModulePaths(path.dirname(configPath));
    // return withPlugins(config, [require("./plugins/direct")]), version from package.json
    await recordRequires(async () =>
      config._compile(
        "require('./plugins/direct'); require('./package.json');",
        configPath,
      ),
    );
    const read = () =>
      readExpoSettings(project, { plugins: [] }, "ios", configPath);
    const before = read();
    expect(before["expo.config"]).toMatch(/^sha256:/);

    await fs.writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ version: "2.0.0" }),
    );
    expect(read()).toEqual(before);

    await fs.writeFile(
      path.join(project, "plugins/native.json"),
      JSON.stringify({ pod: "B" }),
    );
    const withNewData = read();
    expect(withNewData).not.toEqual(before);

    await fs.writeFile(
      path.join(project, "plugins/direct.js"),
      "require('./native.json'); module.exports = (c) => ({ ...c });",
    );
    expect(read()).not.toEqual(withNewData);
  });

  it("resolves a local TypeScript plugin named without its extension", async () => {
    await fs.writeFile(
      path.join(project, "plugins/withTs.ts"),
      "export default (config: unknown) => config;",
    );
    const source = JSON.parse(
      readExpoSettings(project, { plugins: ["./plugins/withTs"] }, "ios")[
        "expo.plugin[0]:./plugins/withTs"
      ]!,
    ).source;

    expect(source).toMatch(/^sha256:/);
  });

  it("counts a registry plugin passed as a function, or imported by app.config.js, by its version", async () => {
    const registry = path.join(project, "node_modules/expo-reg-plugin");
    await fs.mkdir(registry, { recursive: true });
    const setVersion = (version: string) =>
      fs.writeFile(
        path.join(registry, "package.json"),
        JSON.stringify({ name: "expo-reg-plugin", version, main: "index.js" }),
      );
    await setVersion("1.0.0");
    await fs.writeFile(
      path.join(registry, "index.js"),
      "module.exports = function withReg(config) { return config; };",
    );
    const withReg = createRequire(path.join(project, "package.json"))(
      "expo-reg-plugin",
    ) as () => unknown;

    expect(
      JSON.parse(
        readExpoSettings(project, { plugins: [withReg] }, "ios")[
          "expo.plugin[0]:withReg"
        ]!,
      ).source,
    ).toBe("expo-reg-plugin@1.0.0");

    // return withPlugins(config, [require("expo-reg-plugin")])
    await fs.writeFile(path.join(project, "app.config.js"), "");
    const configPath = await fs.realpath(path.join(project, "app.config.js"));
    const config = new Module(configPath) as Module & {
      _compile: (code: string, filename: string) => void;
    };
    config.filename = configPath;
    config.paths = (
      Module as unknown as { _nodeModulePaths: (dir: string) => string[] }
    )._nodeModulePaths(path.dirname(configPath));
    await recordRequires(async () =>
      config._compile("require('expo-reg-plugin');", configPath),
    );
    const read = () =>
      readExpoSettings(project, { plugins: [] }, "ios", configPath);
    const before = read();
    expect(before["expo.config"]).toMatch(/^sha256:/);

    await setVersion("1.1.0");
    expect(read()).not.toEqual(before);
  });

  it("follows a local helper to the registry plugin it applies", async () => {
    const registry = path.join(project, "node_modules/expo-deep-plugin");
    await fs.mkdir(registry, { recursive: true });
    const setVersion = (version: string) =>
      fs.writeFile(
        path.join(registry, "package.json"),
        JSON.stringify({ name: "expo-deep-plugin", version, main: "index.js" }),
      );
    await setVersion("1.0.0");
    await fs.writeFile(
      path.join(registry, "index.js"),
      "module.exports = (c) => c;",
    );
    await fs.writeFile(
      path.join(project, "plugins/applyDeep.js"),
      "module.exports = require('expo-deep-plugin');",
    );
    await fs.writeFile(path.join(project, "app.config.js"), "");
    const configPath = await fs.realpath(path.join(project, "app.config.js"));
    const config = new Module(configPath) as Module & {
      _compile: (code: string, filename: string) => void;
    };
    config.filename = configPath;
    config.paths = (
      Module as unknown as { _nodeModulePaths: (dir: string) => string[] }
    )._nodeModulePaths(path.dirname(configPath));
    await recordRequires(async () =>
      config._compile("require('./plugins/applyDeep');", configPath),
    );
    const read = () =>
      readExpoSettings(project, { plugins: [] }, "ios", configPath);
    const before = read();

    await setVersion("1.1.0");
    expect(read()).not.toEqual(before);
  });

  it("counts a plugin's own package.json, only the app's is left out", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-own-manifest-")),
    );
    try {
      const writeManifest = (pod: string) =>
        fs.writeFile(
          path.join(workspace, "package.json"),
          JSON.stringify({
            name: "@acme/manifest-plugin",
            version: "1.0.0",
            pod,
          }),
        );
      await writeManifest("A");
      await fs.writeFile(
        path.join(workspace, "app.plugin.js"),
        "require('./package.json'); module.exports = (c) => c;",
      );
      await fs.mkdir(path.join(project, "node_modules/@acme"), {
        recursive: true,
      });
      await fs.symlink(
        workspace,
        path.join(project, "node_modules/@acme/manifest-plugin"),
      );
      createRequire(path.join(project, "package.json"))(
        "@acme/manifest-plugin/app.plugin.js",
      );
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["@acme/manifest-plugin"] },
          "ios",
        );
      const before = read();

      await writeManifest("B");
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("follows the ESM imports of a local plugin", async () => {
    await fs.writeFile(
      path.join(project, "plugins/esmHelper.mjs"),
      "export default 1;",
    );
    await fs.writeFile(
      path.join(project, "plugins/withEsm.mjs"),
      "import helper from './esmHelper.mjs'; export default (config) => config;",
    );
    const read = () =>
      readExpoSettings(project, { plugins: ["./plugins/withEsm.mjs"] }, "ios");
    const before = read();

    await fs.writeFile(
      path.join(project, "plugins/esmHelper.mjs"),
      "export default 2;",
    );
    expect(read()).not.toEqual(before);
  });

  it("loads a workspace package's app.plugin file even when its exports leave it out", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-exports-")),
    );
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          name: "@acme/exported-plugin",
          version: "1.0.0",
          exports: { ".": "./index.js" },
        }),
      );
      await fs.writeFile(
        path.join(workspace, "index.js"),
        "module.exports = {};",
      );
      await fs.writeFile(
        path.join(workspace, "helper.js"),
        "module.exports = 1;",
      );
      await fs.writeFile(
        path.join(workspace, "app.plugin.js"),
        "require('./helper'); module.exports = (c) => c;",
      );
      await fs.mkdir(path.join(project, "node_modules/@acme"), {
        recursive: true,
      });
      await fs.symlink(
        workspace,
        path.join(project, "node_modules/@acme/exported-plugin"),
      );
      // Expo requires the file from the package folder.
      createRequire(path.join(project, "package.json"))(
        path.join(workspace, "app.plugin.js"),
      );
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["@acme/exported-plugin"] },
          "ios",
        );
      const before = read();

      await fs.writeFile(
        path.join(workspace, "helper.js"),
        "module.exports = 2;",
      );
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("follows an ESM plugin into a workspace package's import target", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-esm-ws-")),
    );
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          name: "@acme/esm-helper",
          version: "1.0.0",
          exports: { ".": { import: "./esm.mjs", require: "./cjs.cjs" } },
        }),
      );
      await fs.writeFile(
        path.join(workspace, "cjs.cjs"),
        "module.exports = 1;",
      );
      await fs.writeFile(path.join(workspace, "impl.mjs"), "export default 1;");
      await fs.writeFile(
        path.join(workspace, "esm.mjs"),
        "export { default } from './impl.mjs';",
      );
      await fs.mkdir(path.join(project, "node_modules/@acme"), {
        recursive: true,
      });
      await fs.symlink(
        workspace,
        path.join(project, "node_modules/@acme/esm-helper"),
      );
      await fs.writeFile(
        path.join(project, "plugins/withEsmWorkspace.mjs"),
        "import helper from '@acme/esm-helper'; export default (config) => config;",
      );
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["./plugins/withEsmWorkspace.mjs"] },
          "ios",
        );
      const before = read();

      await fs.writeFile(path.join(workspace, "impl.mjs"), "export default 2;");
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("matches a workspace package's export pattern for an ESM subpath import", async () => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-pattern-")),
    );
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          name: "@acme/patterned",
          version: "1.0.0",
          exports: { "./*": "./src/*.mjs" },
        }),
      );
      await fs.mkdir(path.join(workspace, "src"));
      await fs.writeFile(
        path.join(workspace, "src/foo.mjs"),
        "export default 1;",
      );
      await fs.mkdir(path.join(project, "node_modules/@acme"), {
        recursive: true,
      });
      await fs.symlink(
        workspace,
        path.join(project, "node_modules/@acme/patterned"),
      );
      await fs.writeFile(
        path.join(project, "plugins/withPattern.mjs"),
        "import foo from '@acme/patterned/foo'; export default (config) => config;",
      );
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["./plugins/withPattern.mjs"] },
          "ios",
        );
      const before = read();

      await fs.writeFile(
        path.join(workspace, "src/foo.mjs"),
        "export default 2;",
      );
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  // A workspace package `@acme/<name>` linked into the project, with an ESM
  // plugin that imports `specifier`; returns the package directory.
  const linkWorkspacePackage = async (
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
    specifier: string,
  ) => {
    const workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), `hot-updater-${name}-`)),
    );
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: `@acme/${name}`, version: "1.0.0", ...manifest }),
    );
    for (const [file, contents] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(workspace, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(workspace, file), contents);
    }
    await fs.mkdir(path.join(project, "node_modules/@acme"), {
      recursive: true,
    });
    await fs.symlink(
      workspace,
      path.join(project, `node_modules/@acme/${name}`),
    );
    await fs.writeFile(
      path.join(project, `plugins/with-${name}.mjs`),
      `import helper from '${specifier}'; export default (config) => config;`,
    );
    return workspace;
  };

  it("prefers the most specific export pattern, as Node does", async () => {
    const workspace = await linkWorkspacePackage(
      "specific",
      { exports: { "./*": "./general/*", "./*.js": "./specific/*.mjs" } },
      {
        "general/foo.js": "export default 1;",
        "specific/foo.mjs": "export default 1;",
      },
      "@acme/specific/foo.js",
    );
    try {
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["./plugins/with-specific.mjs"] },
          "ios",
        );
      const before = read();
      await fs.writeFile(
        path.join(workspace, "specific/foo.mjs"),
        "export default 2;",
      );
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("follows export conditions in declaration order", async () => {
    const workspace = await linkWorkspacePackage(
      "ordered",
      { exports: { node: "./node.mjs", import: "./import.mjs" } },
      { "node.mjs": "export default 1;", "import.mjs": "export default 1;" },
      "@acme/ordered",
    );
    try {
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["./plugins/with-ordered.mjs"] },
          "ios",
        );
      const before = read();
      await fs.writeFile(path.join(workspace, "node.mjs"), "export default 2;");
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("follows a workspace package's imports map", async () => {
    const workspace = await linkWorkspacePackage(
      "mapped",
      {
        type: "module",
        exports: "./index.mjs",
        imports: { "#native": "./native.mjs" },
      },
      {
        "index.mjs": "import native from '#native'; export default native;",
        "native.mjs": "export default 1;",
      },
      "@acme/mapped",
    );
    try {
      const read = () =>
        readExpoSettings(
          project,
          { plugins: ["./plugins/with-mapped.mjs"] },
          "ios",
        );
      const before = read();
      await fs.writeFile(
        path.join(workspace, "native.mjs"),
        "export default 2;",
      );
      expect(read()).not.toEqual(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("numbers plugins without Hot Updater's own, so moving it changes nothing", () => {
    const read = (plugins: unknown[]) =>
      readExpoSettings(project, { plugins }, "ios");
    const hotUpdater = ["@hot-updater/expo", { channel: "production" }];

    expect(read([hotUpdater, "expo-build-properties"])).toEqual(
      read(["expo-build-properties", hotUpdater]),
    );
  });

  it("leaves out what the app config doesn't declare", () => {
    expect(readExpoSettings(project, {}, "ios")).toEqual({});
  });
});
