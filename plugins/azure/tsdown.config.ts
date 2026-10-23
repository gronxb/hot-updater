import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    // CommonJS stays for consumers that `require` the package, though every
    // supported Node.js can `require` ESM.
    checks: { legacyCjs: false },
    failOnWarn: true,
  },
  {
    // The Function App init deploys: one file with every dependency, so the
    // deployment installs nothing. The Functions host supplies
    // `@azure/functions-core`; `onlyImport` fails the build if any other
    // import is left out of the bundle.
    entry: { index: "functions/index.ts" },
    format: ["esm"],
    outDir: "dist/functions",
    platform: "node",
    target: "node22",
    dts: false,
    copy: { from: "functions/host.json", to: "dist/functions" },
    // JSDoc of bundled packages only adds weight to the deployment.
    outputOptions: { codeSplitting: false, comments: { jsdoc: false } },
    deps: {
      alwaysBundle: [/./],
      neverBundle: ["@azure/functions-core"],
      onlyImport: ["@azure/functions-core"],
    },
    failOnWarn: true,
  },
  {
    // `./init`: the provider's init, which `hot-updater init` imports once it
    // has installed this package.
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/init",
    checks: { legacyCjs: false },
    deps: {
      neverBundle: ["@hot-updater/azure"],
    },
    failOnWarn: true,
  },
]);
