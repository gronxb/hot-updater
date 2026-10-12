import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const source = "@rspack/core:chunkGraph";
const resourceRoot = fileURLToPath(
  new URL("./compiler-page-resources/", import.meta.url),
);
const loader = fileURLToPath(
  new URL("./compiler-page-resource-loader.cjs", import.meta.url),
);

const resourceKinds = (resourceSet) => {
  const kinds = ["probe"];
  if (["dynamic", "sdk2", "sdk3"].includes(resourceSet)) kinds.push("dynamic");
  if (["external", "external2", "sdk2", "sdk3"].includes(resourceSet))
    kinds.push("bootstrap");
  if (!["basic", "http", "sdk1"].includes(resourceSet)) kinds.push("font");
  return kinds.sort(compare);
};

export const compilerPageResourceEntries = (resourceSet) =>
  resourceKinds(resourceSet).map((kind) =>
    path.join(resourceRoot, `${kind}.page-resource`),
  );

const logicalPage = (filename) => filename.replace(/\.lynx\.bundle$/, "");
const nodeId = (kind, name) => `${kind}:${name}`;
const normalizeModule = (identifier) => {
  const marker = "/spike/compiler-page-resources/";
  const normalized = identifier.split(path.sep).join("/");
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return undefined;
  const match = normalized
    .slice(index + 1)
    .match(/^spike\/compiler-page-resources\/[^|!]+\.page-resource/);
  return match?.[0];
};

export const compilerPageGraphPlugin = ({ resourceEntries }) => ({
  name: "hot-updater-lynx-page-graph",
  setup(api) {
    api.modifyRspackConfig((config, { environment }) => {
      if (environment.name !== "lynx") return;
      const mainEntry = config.entry?.main;
      if (
        !mainEntry ||
        typeof mainEntry !== "object" ||
        !Array.isArray(mainEntry.import) ||
        !Array.isArray(resourceEntries) ||
        resourceEntries.length === 0 ||
        new Set(resourceEntries).size !== resourceEntries.length ||
        resourceEntries.some(
          (entry) =>
            !path.isAbsolute(entry) ||
            !entry.startsWith(resourceRoot) ||
            !entry.endsWith(".page-resource"),
        )
      ) {
        throw new Error(
          "Compiler page resources require one resolved main entry",
        );
      }
      mainEntry.import.unshift(...resourceEntries);
      config.module ??= {};
      config.module.rules ??= [];
      config.module.rules.push({
        test: /\.page-resource$/,
        type: "javascript/auto",
        use: [{ loader }],
      });
      config.plugins ??= [];
      config.plugins.unshift({
        apply(compiler) {
          const templatePlugins = compiler.options.plugins.filter(
            (plugin) =>
              typeof plugin?.constructor?.getLynxTemplatePluginHooks ===
              "function",
          );
          const templateConstructors = new Set(
            templatePlugins.map((plugin) => plugin.constructor),
          );
          if (templatePlugins.length !== 2 || templateConstructors.size !== 1) {
            throw new Error(
              "Compiler page graph requires one LynxTemplatePlugin per page",
            );
          }
          let graph;
          compiler.hooks.thisCompilation.tap(
            "HotUpdaterLynxPageGraph",
            (compilation) => {
              const encodedAsyncAssets = new Map();
              const [TemplatePlugin] = templateConstructors;
              TemplatePlugin.getLynxTemplatePluginHooks(
                compilation,
              ).beforeEmit.tap("HotUpdaterLynxPageGraph", (output) => {
                if (
                  ["detail.lynx.bundle", "main.lynx.bundle"].includes(
                    output.outputName,
                  )
                )
                  return output;
                // The pinned template versions expose names (0.10) or groups (0.13).
                const groups =
                  output.chunkGroups ??
                  compilation.chunkGroups.filter((group) =>
                    output.entryNames?.includes(group.name),
                  );
                if (
                  groups.length === 0 ||
                  groups.some((group) => group.isInitial()) ||
                  (output.entryNames &&
                    output.entryNames.some(
                      (name) => !groups.some((group) => group.name === name),
                    ))
                ) {
                  throw new Error(
                    "Compiler async template has no resolved chunk group",
                  );
                }
                for (const group of groups) {
                  const assets = encodedAsyncAssets.get(group) ?? new Set();
                  assets.add(output.outputName);
                  encodedAsyncAssets.set(group, assets);
                }
                return output;
              });
              compilation.hooks.processAssets.tap(
                {
                  name: "HotUpdaterLynxPageGraph",
                  stage:
                    compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT +
                    2,
                },
                () => {
                  const nodes = new Map();
                  const edges = new Map();
                  const addNode = (node) => {
                    const existing = nodes.get(node.id);
                    if (
                      existing &&
                      JSON.stringify(existing) !== JSON.stringify(node)
                    ) {
                      throw new Error("Compiler page graph node is ambiguous");
                    }
                    nodes.set(node.id, node);
                  };
                  const addEdge = (edge) =>
                    edges.set(JSON.stringify(edge), edge);
                  const taggedAssets = new Map(
                    compilation
                      .getAssets()
                      .filter(
                        (asset) =>
                          typeof asset.info.hotUpdaterPageEssential ===
                          "boolean",
                      )
                      .map((asset) => [asset.name, asset]),
                  );
                  const ownedAssets = new Set();
                  const entries = [
                    "detail.lynx.bundle",
                    "main.lynx.bundle",
                  ].map((entry) => {
                    const page = logicalPage(entry);
                    const threadEntries = [
                      `${page}__main-thread`,
                      `${page}__octane_main_thread`,
                    ].filter((name) => compilation.entrypoints.has(name));
                    const compilerEntries = [page, ...threadEntries].sort(
                      compare,
                    );
                    if (
                      !compilation.getAsset(entry) ||
                      !compilation.entrypoints.has(page) ||
                      threadEntries.length !== 1
                    ) {
                      throw new Error(
                        "Compiler page graph did not resolve every Lynx page output",
                      );
                    }
                    const pageNode = nodeId("page", entry);
                    addNode({ id: pageNode, kind: "page", path: entry });
                    const resources = new Set([entry]);
                    const asyncAssets = new Set();
                    for (const compilerEntry of compilerEntries) {
                      const entrypoint =
                        compilation.entrypoints.get(compilerEntry);
                      if (!entrypoint) {
                        throw new Error(
                          `Compiler page graph cannot resolve entry ${compilerEntry}`,
                        );
                      }
                      const entryNode = nodeId("entry", compilerEntry);
                      addNode({
                        id: entryNode,
                        kind: "entry",
                        name: compilerEntry,
                      });
                      addEdge({
                        from: pageNode,
                        kind: "compiledBy",
                        to: entryNode,
                      });
                      const descendants = new Set(entrypoint.childrenIterable);
                      for (const group of descendants) {
                        for (const child of group.childrenIterable)
                          descendants.add(child);
                      }
                      const asyncGroups = [...descendants].filter(
                        (group) => !group.isInitial(),
                      );
                      const asyncChunks = new Set(
                        asyncGroups.flatMap((group) => group.chunks),
                      );
                      for (const group of asyncGroups) {
                        const index = compilation.chunkGroups.indexOf(group);
                        if (index < 0)
                          throw new Error(
                            "Compiler async group is not part of this compilation",
                          );
                        const name = String(index);
                        const groupNode = nodeId("async-group", name);
                        addNode({ id: groupNode, kind: "async-group", name });
                        addEdge({
                          from: entryNode,
                          kind: "contains",
                          to: groupNode,
                        });
                        for (const chunk of group.chunks) {
                          addEdge({
                            from: groupNode,
                            kind: "contains",
                            to: nodeId("chunk", String(chunk.name ?? chunk.id)),
                          });
                        }
                        for (const output of encodedAsyncAssets.get(group) ??
                          []) {
                          if (!compilation.getAsset(output))
                            throw new Error(
                              "Compiler async template output is missing",
                            );
                          const assetNode = nodeId("async-asset", output);
                          addNode({
                            id: assetNode,
                            kind: "async-asset",
                            path: output,
                          });
                          addEdge({
                            from: groupNode,
                            kind: "emits",
                            to: assetNode,
                          });
                          asyncAssets.add(output);
                        }
                      }
                      for (const chunk of new Set([
                        ...entrypoint.chunks,
                        ...asyncChunks,
                      ])) {
                        const chunkName = String(chunk.name ?? chunk.id);
                        const chunkNode = nodeId("chunk", chunkName);
                        addNode({
                          id: chunkNode,
                          kind: "chunk",
                          name: chunkName,
                        });
                        if (entrypoint.chunks.includes(chunk))
                          addEdge({
                            from: entryNode,
                            kind: "contains",
                            to: chunkNode,
                          });
                        if (!entrypoint.chunks.includes(chunk)) {
                          const outputs = [...chunk.files].filter((name) =>
                            compilation.getAsset(name),
                          );
                          for (const name of outputs) {
                            const assetNode = nodeId("async-asset", name);
                            addNode({
                              id: assetNode,
                              kind: "async-asset",
                              path: name,
                            });
                            addEdge({
                              from: chunkNode,
                              kind: "emits",
                              to: assetNode,
                            });
                            asyncAssets.add(name);
                          }
                        }
                        for (const module of compilation.chunkGraph.getOrderedChunkModulesIterable(
                          chunk,
                          (left, right) =>
                            compare(left.identifier(), right.identifier()),
                        )) {
                          const name = normalizeModule(module.identifier());
                          if (!name) continue;
                          const moduleNode = nodeId("module", name);
                          addNode({ id: moduleNode, kind: "module", name });
                          addEdge({
                            from: chunkNode,
                            kind: "contains",
                            to: moduleNode,
                          });
                        }
                        for (const assetName of chunk.auxiliaryFiles) {
                          const asset = taggedAssets.get(assetName);
                          if (!asset) continue;
                          const sourceName = normalizeModule(
                            String(asset.info.sourceFilename ?? ""),
                          );
                          const moduleNode = sourceName
                            ? nodeId("module", sourceName)
                            : undefined;
                          if (!moduleNode || !nodes.has(moduleNode)) {
                            throw new Error(
                              `Compiler page dependency ${assetName} has no source module`,
                            );
                          }
                          const assetNode = nodeId("asset", assetName);
                          addNode({
                            essential: asset.info.hotUpdaterPageEssential,
                            id: assetNode,
                            kind: "asset",
                            path: assetName,
                            source: sourceName,
                          });
                          addEdge({
                            from: moduleNode,
                            kind: "emits",
                            to: assetNode,
                          });
                          if (asset.info.hotUpdaterPageEssential) {
                            resources.add(assetName);
                            addEdge({
                              from: pageNode,
                              kind: "requires",
                              to: assetNode,
                            });
                          }
                          ownedAssets.add(assetName);
                        }
                      }
                    }
                    return {
                      asyncAssets: [...asyncAssets].sort(compare),
                      compilerEntries,
                      entry,
                      resources: [...resources].sort(compare),
                    };
                  });
                  if (
                    ownedAssets.size !== taggedAssets.size ||
                    [...taggedAssets].some(([name]) => !ownedAssets.has(name))
                  ) {
                    throw new Error(
                      "Compiler page graph has an unowned page dependency",
                    );
                  }
                  const auxiliaryAssets = [...taggedAssets]
                    .filter(([, asset]) => !asset.info.hotUpdaterPageEssential)
                    .map(([name]) => name)
                    .sort(compare);
                  graph = {
                    auxiliaryAssets,
                    compilerVersion: compiler.webpack.rspackVersion,
                    edges: [...edges.values()].sort((left, right) =>
                      compare(JSON.stringify(left), JSON.stringify(right)),
                    ),
                    entries,
                    nodes: [...nodes.values()].sort((left, right) =>
                      compare(left.id, right.id),
                    ),
                    schemaVersion: 2,
                    source,
                  };
                },
              );
            },
          );
          compiler.hooks.done.tapPromise(
            "HotUpdaterLynxPageGraph",
            async () => {
              try {
                if (!graph) {
                  throw new Error("Compiler did not expose a Lynx page graph");
                }
                await fs.writeFile(
                  `${environment.distPath}.page-graph.json`,
                  `${JSON.stringify(graph, null, 2)}\n`,
                );
              } finally {
                graph = undefined;
              }
            },
          );
        },
      });
    });
  },
});
