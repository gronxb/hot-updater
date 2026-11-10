import { defineConfig } from "tsdown";

// Every config writes package.json's exports and the inlinedDependencies
// field, so the field lists the versions dist actually bundles.
const exports = {
  customExports: {
    ".": {
      types: "./dist/index.d.mts",
      import: "./dist/index.mjs",
    },
    "./node": {
      import: { types: "./dist/node.d.mts", default: "./dist/node.mjs" },
      require: { types: "./dist/node.d.cts", default: "./dist/node.cjs" },
    },
    "./react-native": {
      import: {
        types: "./dist/react-native.d.mts",
        default: "./dist/react-native.mjs",
      },
      require: {
        types: "./dist/react-native.d.cts",
        default: "./dist/react-native.cjs",
      },
    },
  },
  inlinedDependencies: true,
  legacy: true,
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    clean: true,
    dts: true,
    failOnWarn: true,
    exports,
  },
  {
    entry: ["src/node.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    clean: false,
    dts: true,
    failOnWarn: true,
    exports,
  },
  {
    // Client plugin tests run under Vitest or Jest, so both formats ship.
    entry: ["src/react-native.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    clean: false,
    dts: true,
    failOnWarn: true,
    exports,
  },
]);
