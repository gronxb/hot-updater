import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getBundleZipTargets } from "./getBundleZipTargets";

describe("getBundleZipTargets", () => {
  it("should select only HBC bundle files and remove the extension when HBC bundles are present (iOS)", async () => {
    const files = [
      "/path/to/assets/src/logo.png",
      "/path/to/BUNDLE_ID",
      "/path/to/index.ios.bundle",
      "/path/to/index.ios.bundle.map",
      "/path/to/index.ios.bundle.hbc",
      "/path/to/index.ios.bundle.hbc.map",
    ];

    const result = await getBundleZipTargets("/path/to", files);

    expect(result).toEqual(
      expect.arrayContaining([
        { path: "/path/to/assets/src/logo.png", name: "assets/src/logo.png" },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        { path: "/path/to/index.ios.bundle.hbc", name: "index.ios.bundle" },
      ]),
    );
  });

  it("should use regular bundle files when no HBC bundle files are present (iOS)", async () => {
    const files = [
      "/path/to/assets/src/logo.png",
      "/path/to/BUNDLE_ID2",
      "/path/to/BUNDLE_ID",
      "/path/to/index.ios.bundle",
      "/path/to/index.ios.bundle.map",
    ];

    const result = await getBundleZipTargets("/path/to", files);

    expect(result).toEqual(
      expect.arrayContaining([
        { path: "/path/to/assets/src/logo.png", name: "assets/src/logo.png" },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        { path: "/path/to/BUNDLE_ID2", name: "BUNDLE_ID2" },
        { path: "/path/to/index.ios.bundle", name: "index.ios.bundle" },
      ]),
    );
  });

  it("should select only HBC bundle files and remove the extension when HBC bundles are present (Android)", async () => {
    const files = [
      "/path/to/drawables/src/logo.png",
      "/path/to/drawables/image.png",
      "/path/to/BUNDLE_ID",
      "/path/to/index.android.bundle",
      "/path/to/index.android.bundle.map",
      "/path/to/index.android.bundle.hbc",
      "/path/to/index.android.bundle.hbc.map",
    ];

    const result = await getBundleZipTargets("/path/to", files);

    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: "/path/to/drawables/src/logo.png",
          name: "drawables/src/logo.png",
        },
        {
          path: "/path/to/drawables/image.png",
          name: "drawables/image.png",
        },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        {
          path: "/path/to/index.android.bundle.hbc",
          name: "index.android.bundle",
        },
      ]),
    );
  });

  it("should use regular bundle files when no HBC bundle files are present (Android)", async () => {
    const files = [
      "/path/to/drawables/src/logo.png",
      "/path/to/drawables/image.png",
      "/path/to/BUNDLE_ID2",
      "/path/to/BUNDLE_ID",
      "/path/to/index.android.bundle",
      "/path/to/index.android.bundle.map",
    ];

    const result = await getBundleZipTargets("/path/to", files);

    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: "/path/to/drawables/src/logo.png",
          name: "drawables/src/logo.png",
        },
        {
          path: "/path/to/drawables/image.png",
          name: "drawables/image.png",
        },
        { path: "/path/to/BUNDLE_ID", name: "BUNDLE_ID" },
        { path: "/path/to/BUNDLE_ID2", name: "BUNDLE_ID2" },
        { path: "/path/to/index.android.bundle", name: "index.android.bundle" },
      ]),
    );
  });

  it("realData", async () => {
    const files = [
      "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/BUNDLE_ID",
      "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/index.android.bundle",
      "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/index.android.bundle.hbc",
      "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/src_logo.png",
    ];

    const result = await getBundleZipTargets(
      "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist",
      files,
    );

    expect(result).toEqual(
      expect.arrayContaining([
        {
          path: "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/src_logo.png",
          name: "src_logo.png",
        },
        {
          path: "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/index.android.bundle.hbc",
          name: "index.android.bundle",
        },
        {
          path: "/Users/xx/Desktop/hot-updater/examples/v0.71.19/dist/BUNDLE_ID",
          name: "BUNDLE_ID",
        },
      ]),
    );
  });
});

describe("getBundleZipTargets with preserve policy", () => {
  let directory: string;
  let buildPath: string;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "opaque-build-")),
    );
    buildPath = path.join(directory, "build");
    await fs.mkdir(buildPath);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("preserves paired bundles, maps and nested runtime dependencies", async () => {
    const names = [
      "main.bundle",
      "main.bundle.hbc",
      "main.bundle.map",
      "async/bootstrap.bundle",
      "assets/runtime.map",
    ];
    for (const name of names) {
      const file = path.join(buildPath, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `opaque ${name}`);
    }
    const files = (await fs.readdir(buildPath, { recursive: true })).map(
      (name) => path.join(buildPath, name),
    );
    const targets = await getBundleZipTargets(buildPath, files, "preserve");
    expect(targets.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      names
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, path: path.join(buildPath, name) })),
    );
  });

  it.each(["file", "directory"])(
    "rejects a reserved root manifest %s even when omitted from selected files",
    async (kind) => {
      const reserved = path.join(buildPath, "manifest.json");
      if (kind === "directory") await fs.mkdir(reserved);
      else await fs.writeFile(reserved, "compiler metadata");
      await expect(
        getBundleZipTargets(buildPath, [], "preserve"),
      ).rejects.toThrow("reserved manifest.json");
    },
  );

  it("rejects a case alias of the root manifest for portable archives", async () => {
    const alias = path.join(buildPath, "MANIFEST.JSON");
    await fs.writeFile(alias, "compiler metadata");
    await expect(
      getBundleZipTargets(buildPath, [alias], "preserve"),
    ).rejects.toThrow("reserved manifest.json");
  });

  it("rejects traversal and a sibling whose name shares the build prefix", async () => {
    const outside = path.join(directory, "build-other", "secret.bundle");
    await fs.mkdir(path.dirname(outside));
    await fs.writeFile(outside, "outside");
    await expect(
      getBundleZipTargets(buildPath, [outside], "preserve"),
    ).rejects.toThrow("outside the build directory");
    await fs.writeFile(path.join(buildPath, "entry.bundle"), "entry");
    await expect(
      getBundleZipTargets(
        buildPath,
        [`${buildPath}/../build/entry.bundle`],
        "preserve",
      ),
    ).rejects.toThrow("Invalid build artifact path");
  });

  it("rejects a symbolic file and a symbolic ancestor even when their targets stay inside the build", async () => {
    const actual = path.join(buildPath, "actual");
    await fs.mkdir(actual);
    await fs.writeFile(path.join(actual, "entry.bundle"), "entry");
    const alias = path.join(buildPath, "alias");
    await fs.symlink(actual, alias, "dir");
    await expect(
      getBundleZipTargets(
        buildPath,
        [path.join(alias, "entry.bundle")],
        "preserve",
      ),
    ).rejects.toThrow("symbolic links");
    const linkedFile = path.join(buildPath, "entry.bundle");
    await fs.symlink(path.join(actual, "entry.bundle"), linkedFile, "file");
    await expect(
      getBundleZipTargets(buildPath, [linkedFile], "preserve"),
    ).rejects.toThrow("regular file");
    await expect(
      getBundleZipTargets(
        alias,
        [path.join(alias, "entry.bundle")],
        "preserve",
      ),
    ).rejects.toThrow("symbolic links");
  });

  it("allows a symbolic parent outside the artifact root while rejecting symbolic descendants", async () => {
    const nested = path.join(buildPath, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "entry.bundle"), "entry");
    const parentAlias = path.join(directory, "parent-alias");
    await fs.symlink(directory, parentAlias, "dir");
    const aliasedRoot = path.join(parentAlias, "build");
    const aliasedFile = path.join(aliasedRoot, "nested", "entry.bundle");

    await expect(
      getBundleZipTargets(aliasedRoot, [aliasedFile], "preserve"),
    ).resolves.toEqual([{ path: aliasedFile, name: "nested/entry.bundle" }]);

    await fs.symlink(nested, path.join(buildPath, "nested-alias"), "dir");
    await expect(
      getBundleZipTargets(
        aliasedRoot,
        [path.join(aliasedRoot, "nested-alias", "entry.bundle")],
        "preserve",
      ),
    ).rejects.toThrow("symbolic links");
  });

  it("rejects an unknown file policy instead of silently applying RN filtering", async () => {
    const file = path.join(buildPath, "runtime.map");
    await fs.writeFile(file, "runtime dependency");
    await expect(
      getBundleZipTargets(buildPath, [file], "preserv" as never),
    ).rejects.toThrow("Unsupported build file policy: preserv");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a socket without reading or archiving it",
    async () => {
      const socketPath = path.join(buildPath, "runtime.sock");
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        await expect(
          getBundleZipTargets(buildPath, [socketPath], "preserve"),
        ).rejects.toThrow("regular file");
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
