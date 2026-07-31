import { spawnSync } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPackedConsumer,
  type PackedConsumer,
} from "./packedPackageTestUtils";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const typescriptCli = path.join(
  workspaceRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc6",
);

let consumer: PackedConsumer;

const compileConsumer = (file: string) =>
  spawnSync(
    process.execPath,
    [
      typescriptCli,
      "--exactOptionalPropertyTypes",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--noEmit",
      "--noUncheckedIndexedAccess",
      "--skipLibCheck",
      "false",
      "--strict",
      "--target",
      "ES2022",
      "--verbatimModuleSyntax",
      file,
    ],
    {
      cwd: consumer.directory,
      encoding: "utf8",
    },
  );

beforeAll(async () => {
  consumer = await createPackedConsumer([
    path.join(workspaceRoot, "packages/react-native"),
  ]);
  const packageDirectory = consumer.packageDirectories.get(
    "@hot-updater/react-native",
  );
  if (packageDirectory === undefined) {
    throw new TypeError("Missing packed React Native package.");
  }
  await symlink(
    path.join(workspaceRoot, "packages/react-native/node_modules/react-native"),
    path.join(packageDirectory, "node_modules/react-native"),
    "dir",
  );
  await Promise.all([
    writeFile(
      path.join(consumer.directory, "runtime-metadata.mts"),
      `import {
  getInstallId,
  type PersistedUserIdentity,
} from "@hot-updater/react-native/runtime-metadata";

const installId: string = getInstallId();
const identity: PersistedUserIdentity = { userId: installId };
void identity;
`,
    ),
    writeFile(
      path.join(consumer.directory, "runtime-metadata.cts"),
      `import runtimeMetadata = require("@hot-updater/react-native/runtime-metadata");

const installId: string = runtimeMetadata.getInstallId();
const identity: runtimeMetadata.PersistedUserIdentity = { userId: installId };
void identity;
`,
    ),
  ]);
}, 60_000);

afterAll(async () => {
  await consumer.dispose();
});

describe("packed React Native runtime metadata consumers", () => {
  it.each(["runtime-metadata.mts", "runtime-metadata.cts"])(
    "type-checks strict NodeNext consumer %s",
    (file) => {
      // Given / When
      const result = compileConsumer(file);
      const output = `${result.stdout}${result.stderr}`;

      // Then
      expect(result.status, output).toBe(0);
    },
  );
});
