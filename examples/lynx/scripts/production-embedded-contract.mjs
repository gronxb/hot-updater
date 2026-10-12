import fs from "node:fs/promises";
import path from "node:path";

import tasm from "@lynx-js/tasm";
import ts from "typescript";

export const productionEmbeddedForbiddenMarkers = [
  "http://localhost:3007",
  "http://127.0.0.1:",
  "/matrix-runtime-snapshot",
  "HOT_UPDATER_",
  "E2E_",
  "navigation-boundary",
  "Verify navigation boundary",
  "Capture runtime events",
  "targeted-qa-detox",
  "detail-diagnostic",
];

const pageRequirements = {
  "detail.lynx.bundle": [
    "sparkling-navigation",
    "router.close",
    "Close detail page",
  ],
  "main.lynx.bundle": [
    "sparkling-navigation",
    "router.open",
    "detail.lynx.bundle",
    "Open detail page",
  ],
};

export const productionSdkCalls = {
  "detail.lynx.bundle": ["notifyAppReady"],
  "main.lynx.bundle": [
    "getLaunchConfiguration",
    "init",
    "checkForUpdate",
    "updateBundle",
    "notifyAppReady",
    "reload",
  ],
};

const requiredOptions = { init: "baseURL", checkForUpdate: "updateStrategy" };

async function readSdkCalls(bytes) {
  const decode = tasm.supportNapi() ? tasm.decode_napi : tasm.decode_wasm;
  const decoded = await decode(bytes);
  const calls = new Set();
  for (const script of decoded["background-thread-script"]) {
    if (script.type !== "source") continue;
    const source = ts.createSourceFile(
      "background.js",
      script.content,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS,
    );
    if (source.parseDiagnostics.length) {
      throw new Error("Production embedded JavaScript cannot be parsed");
    }
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const name = node.expression.name.text;
        const option = requiredOptions[name];
        const argument = node.arguments[0];
        if (
          option
            ? argument &&
              ts.isObjectLiteralExpression(argument) &&
              argument.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name)) &&
                  property.name.text === option,
              )
            : node.arguments.length === 0
        ) {
          calls.add(name);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return calls;
}

export async function validateProductionEmbeddedBundles(root) {
  const files = (await fs.readdir(root, { recursive: true }))
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => file.endsWith(".lynx.bundle"))
    .sort();
  const expectedPages = Object.keys(pageRequirements).sort();
  if (expectedPages.some((page) => !files.includes(page))) {
    throw new Error("Production embedded output is missing a page bundle");
  }
  const checks = {};
  for (const file of files) {
    const bytes = await fs.readFile(path.join(root, file));
    const text = bytes.toString("utf8");
    const present = productionEmbeddedForbiddenMarkers.filter((marker) =>
      text.includes(marker),
    );
    if (present.length) {
      throw new Error(
        `Production embedded ${file} contains test diagnostics: ${present.join(", ")}`,
      );
    }
    const required = pageRequirements[file] ?? [];
    const missing = required.filter((marker) => !text.includes(marker));
    if (missing.length) {
      throw new Error(
        `Production embedded ${file} is missing public navigation: ${missing.join(", ")}`,
      );
    }
    const sdkCalls = productionSdkCalls[file] ?? [];
    const calls = sdkCalls.length ? await readSdkCalls(bytes) : new Set();
    const missingSdkCalls = sdkCalls.filter((call) => !calls.has(call));
    if (missingSdkCalls.length) {
      throw new Error(
        `Production embedded ${file} is missing Hot Updater SDK calls: ${missingSdkCalls.join(", ")}`,
      );
    }
    checks[file] = {
      forbiddenPresent: present,
      requiredPresent: required,
      sdkCallsPresent: sdkCalls,
    };
  }
  return {
    schemaVersion: "lynx-production-embedded-contract-v1",
    files,
    forbiddenMarkers: productionEmbeddedForbiddenMarkers,
    checks,
  };
}
