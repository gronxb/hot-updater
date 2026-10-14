import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    failOnWarn: true,
  },
  {
    // The Vercel Function init deploys: one file with every dependency, so
    // the deployment installs nothing. `onlyImport` fails the build if any
    // import other than a Node built-in is left out of the bundle.
    entry: { index: "function/index.ts" },
    format: ["esm"],
    outDir: "dist/function",
    platform: "node",
    target: "node22",
    dts: false,
    // JSDoc of bundled packages only adds weight to the deployment.
    outputOptions: { codeSplitting: false, comments: { jsdoc: false } },
    deps: {
      alwaysBundle: [/./],
      neverBundle: ["pg-native", "cloudflare:sockets"],
      onlyImport: ["pg-native", "cloudflare:sockets"],
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
    deps: {
      neverBundle: ["@hot-updater/vercel"],
    },
    failOnWarn: true,
  },
]);
