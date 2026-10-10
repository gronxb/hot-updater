import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createNativeBuildPlan } from "../mobile/build.ts";
import { createLocalProfile } from "./profile.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Exercise the installed Re.Pack loader and the actual route that failed at
// startup. Rspack's Release mode resolves React's production runtime even when
// an inherited development environment makes Babel/SWC emit jsxDEV calls.
const transformRoute = (env: NodeJS.ProcessEnv) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const appDir = path.resolve("examples/v0.85.0");
const appRequire = createRequire(path.join(appDir, "package.json"));
const loader = appRequire("@callstack/repack/babel-swc-loader").default;
const filename = path.join(appDir, "src/e2eApp/routes/apply-cohort-input-action-route.tsx");
const reactDir = path.dirname(appRequire.resolve("react/package.json"));
loader.call({
  cacheable() {},
  async() {
    return (error, code) => {
      if (error) throw error;
      const module = { exports: {} };
      const requireForRoute = (name) => {
        if (name === "../route-stack") return { Stack: { Screen() {} } };
        if (name === "../screens/apply-cohort-input-action-screen") {
          return { ApplyCohortInputActionScreen() {} };
        }
        if (name === "react/jsx-dev-runtime" || name === "react/jsx-runtime") {
          return require(path.join(reactDir, "cjs", "react-" + name.slice(6) + ".production.js"));
        }
        return appRequire(name);
      };
      try {
        vm.runInNewContext(code, { module, exports: module.exports, require: requireForRoute });
        console.log(JSON.stringify({ name: module.exports.applyCohortInputActionRoute.props.name }));
      } catch (error) {
        console.log(JSON.stringify({ error: error.message }));
      }
    };
  },
  getLogger() { return { warn() {} }; },
  getOptions() { return { hideParallelModeWarning: true }; },
  resourcePath: filename,
  rootContext: appDir,
  context: path.dirname(filename),
  sourceMap: false,
  _compiler: { rspack: appRequire("@rspack/core") },
}, fs.readFileSync(filename, "utf8"));
`,
      ],
      { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" },
    ),
  ) as { name?: string; error?: string };

describe("Release JSX runtime", () => {
  it.each([
    { NODE_ENV: "development", BABEL_ENV: undefined },
    { NODE_ENV: "production", BABEL_ENV: "development" },
  ])(
    "reproduces the startup failure for a development transform: %j",
    (env) => {
      expect(transformRoute(env).error).toContain("jsxDEV");
    },
  );

  it.each(["ios", "android"] as const)(
    "evaluates native %s Release routes with an inherited development environment",
    (platform) => {
      const command = createNativeBuildPlan(
        { platform, dryRun: false },
        root,
      ).at(-1)!;
      expect(
        transformRoute({
          NODE_ENV: "development",
          BABEL_ENV: "development",
          ...command.env,
        }),
      ).toEqual({ name: "ApplyCohortInputAction" });
    },
  );

  it("evaluates local native and OTA routes with the same production runtime", () => {
    const profile = createLocalProfile({
      root,
      platform: "ios",
      runDir: "/unused-local-profile",
      id: "jsx-runtime-test",
      providerPort: 3001,
      controlPort: 3002,
      storagePort: 3003,
      token: "unused",
      storagePassword: "unused",
      env: { NODE_ENV: "development", BABEL_ENV: "development" },
    });
    expect(transformRoute(profile.env)).toEqual({
      name: "ApplyCohortInputAction",
    });
  });
});
