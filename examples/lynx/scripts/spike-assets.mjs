import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { SPARKLING_NAVIGATION_PROVENANCE } from "@hot-updater/lynx/navigationProvenance";
import tasm from "@lynx-js/tasm";

export const pageEntries = ["detail.lynx.bundle", "main.lynx.bundle"];

const compilerGraphSource = "@rspack/core:chunkGraph";
const compilerVersions = { octane: "2.1.4", react: "1.7.11", vue: "1.7.11" };
const comparePaths = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

async function collectFiles(directory) {
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else {
        const bytes = await fs.readFile(absolute);
        files.push({
          path: path.relative(directory, absolute).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(directory);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort(comparePaths)) ===
    JSON.stringify([...keys].sort(comparePaths));

function validateCompilerGraph(graph, files, { requireNonempty }) {
  if (
    !exactKeys(graph, [
      "schemaVersion",
      "source",
      "compilerVersion",
      "entries",
      "auxiliaryAssets",
      "edges",
      "nodes",
    ]) ||
    graph.schemaVersion !== 1 ||
    graph.source !== compilerGraphSource ||
    !/^\d+\.\d+\.\d+$/.test(graph.compilerVersion) ||
    !Array.isArray(graph.entries) ||
    !Array.isArray(graph.auxiliaryAssets) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.nodes)
  ) {
    throw new Error("Compiler did not emit a valid Lynx page graph");
  }
  if (
    JSON.stringify(
      [...graph.nodes].sort((left, right) => comparePaths(left.id, right.id)),
    ) !== JSON.stringify(graph.nodes) ||
    new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length ||
    JSON.stringify(
      [...graph.edges].sort((left, right) =>
        comparePaths(JSON.stringify(left), JSON.stringify(right)),
      ),
    ) !== JSON.stringify(graph.edges) ||
    new Set(graph.edges.map((edge) => JSON.stringify(edge))).size !==
      graph.edges.length
  ) {
    throw new Error("Compiler emitted a nondeterministic Lynx page graph");
  }
  const nodes = new Map();
  for (const node of graph.nodes) {
    const commonValid =
      node !== null &&
      typeof node === "object" &&
      !Array.isArray(node) &&
      typeof node.id === "string" &&
      typeof node.kind === "string";
    const shapeValid =
      (node.kind === "page" &&
        exactKeys(node, ["id", "kind", "path"]) &&
        node.id === `page:${node.path}` &&
        safePath.test(node.path)) ||
      ((node.kind === "entry" || node.kind === "chunk") &&
        exactKeys(node, ["id", "kind", "name"]) &&
        node.id === `${node.kind}:${node.name}` &&
        typeof node.name === "string" &&
        node.name.length > 0) ||
      (node.kind === "module" &&
        exactKeys(node, ["id", "kind", "name"]) &&
        node.id === `module:${node.name}` &&
        /^spike\/compiler-page-resources\/[a-z]+\.page-resource$/.test(
          node.name,
        )) ||
      (node.kind === "asset" &&
        exactKeys(node, ["essential", "id", "kind", "path", "source"]) &&
        node.id === `asset:${node.path}` &&
        typeof node.essential === "boolean" &&
        safePath.test(node.path) &&
        /^spike\/compiler-page-resources\/[a-z]+\.page-resource$/.test(
          node.source,
        ));
    if (!commonValid || !shapeValid) {
      throw new Error("Compiler emitted an invalid Lynx graph node");
    }
    nodes.set(node.id, node);
  }
  const edges = graph.edges.map((edge) => {
    if (
      !exactKeys(edge, ["from", "kind", "to"]) ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !["compiledBy", "contains", "emits", "requires"].includes(edge.kind) ||
      !nodes.has(edge.from) ||
      !nodes.has(edge.to)
    ) {
      throw new Error("Compiler emitted an invalid Lynx graph edge");
    }
    const fromKind = nodes.get(edge.from).kind;
    const toKind = nodes.get(edge.to).kind;
    if (
      (edge.kind === "compiledBy" &&
        (fromKind !== "page" || toKind !== "entry")) ||
      (edge.kind === "contains" &&
        !(
          (fromKind === "entry" && toKind === "chunk") ||
          (fromKind === "chunk" && toKind === "module")
        )) ||
      (edge.kind === "emits" &&
        (fromKind !== "module" || toKind !== "asset")) ||
      (edge.kind === "requires" &&
        (fromKind !== "page" ||
          toKind !== "asset" ||
          !nodes.get(edge.to).essential))
    ) {
      throw new Error("Compiler emitted a type-invalid Lynx graph edge");
    }
    return edge;
  });
  const hasEdge = (from, kind, to) =>
    edges.some(
      (edge) => edge.from === from && edge.kind === kind && edge.to === to,
    );
  for (const node of nodes.values()) {
    if (node.kind !== "asset") continue;
    const moduleId = `module:${node.source}`;
    if (!hasEdge(moduleId, "emits", node.id)) {
      throw new Error("Compiler asset has no module emission edge");
    }
    const chunks = edges
      .filter((edge) => edge.kind === "contains" && edge.to === moduleId)
      .map((edge) => edge.from);
    if (chunks.length === 0) {
      throw new Error("Compiler asset module has no chunk edge");
    }
  }
  const owned = new Set();
  const entries = graph.entries.map((descriptor, index) => {
    const entry = pageEntries[index];
    const page = entry?.replace(/\.lynx\.bundle$/, "");
    const validCompilerEntries = [
      [page, `${page}__main-thread`].sort(comparePaths),
      [page, `${page}__octane_main_thread`].sort(comparePaths),
    ];
    if (
      !entry ||
      !exactKeys(descriptor, ["entry", "compilerEntries", "resources"]) ||
      descriptor.entry !== entry ||
      !validCompilerEntries.some(
        (entries) =>
          JSON.stringify(descriptor.compilerEntries) ===
          JSON.stringify(entries),
      ) ||
      !Array.isArray(descriptor.resources) ||
      !descriptor.resources.includes(entry) ||
      JSON.stringify([...descriptor.resources].sort(comparePaths)) !==
        JSON.stringify(descriptor.resources) ||
      new Set(descriptor.resources).size !== descriptor.resources.length ||
      descriptor.resources.some(
        (resource) => typeof resource !== "string" || !safePath.test(resource),
      )
    ) {
      throw new Error("Compiler emitted an ambiguous Lynx page graph");
    }
    const required = graph.edges
      .filter(
        (edge) => edge.from === `page:${entry}` && edge.kind === "requires",
      )
      .map((edge) => nodes.get(edge.to)?.path)
      .filter((resource) => typeof resource === "string")
      .sort(comparePaths);
    for (const resource of required) {
      const assetNode = nodes.get(`asset:${resource}`);
      const moduleId = `module:${assetNode.source}`;
      const pageEntries = edges
        .filter(
          (edge) => edge.from === `page:${entry}` && edge.kind === "compiledBy",
        )
        .map((edge) => edge.to);
      const pageChunks = edges
        .filter(
          (edge) => pageEntries.includes(edge.from) && edge.kind === "contains",
        )
        .map((edge) => edge.to);
      if (
        !edges.some(
          (edge) =>
            pageChunks.includes(edge.from) &&
            edge.kind === "contains" &&
            edge.to === moduleId,
        )
      ) {
        throw new Error(
          "Compiler page dependency is not reachable from its entry graph",
        );
      }
    }
    const derivedResources = [entry, ...required].sort(comparePaths);
    if (
      JSON.stringify(derivedResources) !== JSON.stringify(descriptor.resources)
    ) {
      throw new Error(
        "Compiler page resources do not match its dependency graph",
      );
    }
    for (const resource of descriptor.resources) owned.add(resource);
    return { entry, resources: descriptor.resources };
  });
  if (entries.length !== pageEntries.length) {
    throw new Error("Compiler page graph is missing a Lynx page output");
  }
  if (
    JSON.stringify([...graph.auxiliaryAssets].sort(comparePaths)) !==
      JSON.stringify(graph.auxiliaryAssets) ||
    new Set(graph.auxiliaryAssets).size !== graph.auxiliaryAssets.length ||
    graph.auxiliaryAssets.some(
      (resource) =>
        typeof resource !== "string" ||
        !safePath.test(resource) ||
        owned.has(resource),
    )
  ) {
    throw new Error("Compiler emitted an ambiguous Lynx auxiliary graph");
  }
  const derivedAuxiliary = [...nodes.values()]
    .filter((node) => node.kind === "asset" && !node.essential)
    .map((node) => node.path)
    .sort(comparePaths);
  if (
    JSON.stringify(derivedAuxiliary) !== JSON.stringify(graph.auxiliaryAssets)
  ) {
    throw new Error("Compiler auxiliary assets do not match its graph");
  }
  const expectedFiles = [...owned, ...graph.auxiliaryAssets].sort(comparePaths);
  if (
    JSON.stringify(files.map((file) => file.path)) !==
    JSON.stringify(expectedFiles)
  ) {
    throw new Error("Compiler page graph has missing or unowned output");
  }
  for (const entry of pageEntries) {
    if (!files.some((file) => file.path === entry && file.bytes > 0)) {
      throw new Error("Compiler emitted an empty Lynx page bundle");
    }
  }
  if (requireNonempty && files.some((file) => file.bytes === 0)) {
    throw new Error("Compiler emitted an empty page dependency");
  }
  return entries;
}

async function readCompilerGraph(directory) {
  let graph;
  try {
    graph = JSON.parse(
      await fs.readFile(`${directory}.page-graph.json`, "utf8"),
    );
  } catch (error) {
    throw new Error("Compiler did not emit a Lynx page graph", {
      cause: error,
    });
  }
  return graph;
}

export async function validateStandardStreamingPageBundles(directory) {
  const decode = tasm.supportNapi() ? tasm.decode_napi : tasm.decode_wasm;
  for (const entry of pageEntries) {
    const decoded = await decode(
      await fs.readFile(path.join(directory, entry)),
    );
    let pageConfig;
    try {
      pageConfig = JSON.parse(decoded["page-config"]);
    } catch (error) {
      throw new Error(`Cannot decode page config from ${entry}`, {
        cause: error,
      });
    }
    if (pageConfig.enableFetchAPIStandardStreaming !== true) {
      throw new Error(
        `${entry} does not enable standard Fetch response streaming`,
      );
    }
    const decodedText = JSON.stringify(decoded);
    if (
      decodedText.includes("lynxExtension") ||
      decodedText.includes("useStreaming")
    ) {
      throw new Error(
        `${entry} contains the deprecated Lynx request streaming extension`,
      );
    }
  }
}

export async function readSpikePageContract(directory) {
  const report = JSON.parse(
    await fs.readFile(`${directory}.build.json`, "utf8"),
  );
  const files = await collectFiles(directory);
  if (JSON.stringify(report.files) !== JSON.stringify(files)) {
    throw new Error("Compiler receipt does not match the frozen build output");
  }
  if (
    JSON.stringify(report.pageEntries) !== JSON.stringify(pageEntries) ||
    report.compilerGraph?.compilerVersion !==
      compilerVersions[report.framework] ||
    JSON.stringify(report.provenance?.sparklingNavigation) !==
      JSON.stringify(SPARKLING_NAVIGATION_PROVENANCE)
  ) {
    throw new Error(
      "Compiler receipt has invalid page or navigation provenance",
    );
  }
  const pageEssentialResources = validateCompilerGraph(
    report.compilerGraph,
    files,
    { requireNonempty: true },
  );
  if (
    JSON.stringify(report.pageEssentialResources) !==
    JSON.stringify(pageEssentialResources)
  ) {
    throw new Error("Compiler receipt has an invalid page dependency closure");
  }
  return {
    pageEntries: report.pageEntries,
    pageEssentialResources: report.pageEssentialResources,
    sparklingNavigation: report.provenance.sparklingNavigation,
  };
}

export async function finishSpike(outDir, framework, variant, provenance) {
  const compilerGraph = await readCompilerGraph(outDir);
  if (compilerGraph.compilerVersion !== compilerVersions[framework]) {
    throw new Error("Compiler page graph came from an unpinned Rspack version");
  }
  const files = await collectFiles(outDir);
  const pageEssentialResources = validateCompilerGraph(compilerGraph, files, {
    requireNonempty: true,
  });
  const report = {
    framework,
    variant,
    entry: "main.lynx.bundle",
    pageEntries,
    pageEssentialResources,
    compilerGraph,
    provenance: {
      ...provenance,
      sparklingNavigation: SPARKLING_NAVIGATION_PROVENANCE,
    },
    files,
  };
  await fs.writeFile(
    `${outDir}.build.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await fs.rm(`${outDir}.page-graph.json`);
  return report;
}
