import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const appRequire = createRequire(path.join(cwd, "package.json"));
const vueRequire = createRequire(appRequire.resolve("vue-lynx/package.json"));
const rspeedyRequire = createRequire(
  appRequire.resolve("@lynx-js/rspeedy/package.json"),
);
const { rspack } = rspeedyRequire("@rspack/core");
const wrapperPackage = vueRequire.resolve(
  "@lynx-js/runtime-wrapper-webpack-plugin/package.json",
);
const { RuntimeWrapperWebpackPlugin } = await import(
  pathToFileURL(path.join(path.dirname(wrapperPackage), "lib/index.js"))
);

export async function buildExternalBootstrap(outDir, variant) {
  const compiler = rspack({
    mode: "production",
    context: cwd,
    target: "web",
    entry: { bootstrap: path.join(cwd, "spike/external-bootstrap.ts") },
    devtool: false,
    // Lynx consumes the wrapper's evaluated return value (.init). Generic JS
    // minification treats that completion value as unused and may negate it.
    optimization: { minimize: false },
    output: {
      path: path.join(outDir, "assets"),
      filename: "bootstrap.js",
      library: { type: "commonjs2" },
      iife: false,
      clean: false,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: "builtin:swc-loader",
          options: {
            jsc: { parser: { syntax: "typescript" }, target: "es2019" },
          },
        },
      ],
    },
    plugins: [
      new rspack.DefinePlugin({ __SPIKE_VARIANT__: JSON.stringify(variant) }),
      new RuntimeWrapperWebpackPlugin({ targetSdkVersion: "3.2" }),
    ],
  });
  try {
    await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) reject(error);
        else if (stats?.hasErrors())
          reject(new Error(stats.toString({ all: false, errors: true })));
        else resolve();
      });
    });
  } finally {
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
