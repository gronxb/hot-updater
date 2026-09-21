import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashFingerprintSourcePath,
  resolveFingerprintSourcePaths,
} from "./fingerprintSourcePaths";

describe("fingerprint source path resolution", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "fingerprint-paths-"));
    await fs.mkdir(path.join(cwd, "profiles/group"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(cwd, "native.json"), "root-v1"),
      fs.writeFile(path.join(cwd, "profiles/native-a.json"), "a-v1"),
      fs.writeFile(path.join(cwd, "profiles/native-b.json"), "b-v1"),
      fs.writeFile(path.join(cwd, "profiles/native-b.toml"), "toml-v1"),
      fs.writeFile(path.join(cwd, "profiles/group/config.txt"), "group-v1"),
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it.each([
    ["root globstar", "**/native.json", "native.json"],
    ["brace", "profiles/*.{json,toml}", "profiles/native-b.toml"],
    ["character class", "profiles/native-[ab].json", "profiles/native-a.json"],
    ["extglob", "profiles/@(native-a|native-b).json", "profiles/native-b.json"],
  ])(
    "supports %s patterns and detects matched changes",
    async (_, pattern, file) => {
      const before = await resolveFingerprintSourcePaths({
        cwd,
        patterns: [pattern],
      });
      expect(before.map((source) => source.filePath)).toContain(file);
      const beforeHash = await hashFingerprintSourcePath(
        before.find((source) => source.filePath === file)!,
      );

      await fs.writeFile(path.join(cwd, file), `${file}-v2`);

      const after = await resolveFingerprintSourcePaths({
        cwd,
        patterns: [pattern],
      });
      const afterHash = await hashFingerprintSourcePath(
        after.find((source) => source.filePath === file)!,
      );
      expect(afterHash.hash).not.toBe(beforeHash.hash);
    },
  );

  it("hashes an exactly named directory as one change-sensitive source", async () => {
    const [source] = await resolveFingerprintSourcePaths({
      cwd,
      includeDirectories: true,
      patterns: ["profiles/group"],
    });
    expect(source).toMatchObject({
      filePath: "profiles/group",
      type: "dir",
    });
    const before = await hashFingerprintSourcePath(source!);

    await fs.writeFile(path.join(cwd, "profiles/group/config.txt"), "group-v2");

    const after = await hashFingerprintSourcePath(source!);
    expect(after.hash).not.toBe(before.hash);
  });

  it("rejects a child injected after directory enumeration", async () => {
    const [source] = await resolveFingerprintSourcePaths({
      cwd,
      includeDirectories: true,
      patterns: ["profiles/group"],
    });
    const originalOpen = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === "config.txt" && !injected) {
        injected = true;
        await fs.writeFile(
          path.join(cwd, "profiles/group/injected.txt"),
          "late child",
        );
      }
      return originalOpen(...args);
    });

    await expect(hashFingerprintSourcePath(source!)).rejects.toThrow(
      "Fingerprint source changed",
    );
  });

  it.skipIf(process.platform === "win32")(
    "hashes a nested symlink to an in-app sibling through directory recursion",
    async () => {
      await fs.mkdir(path.join(cwd, "shared"));
      await fs.writeFile(path.join(cwd, "shared/native.json"), "shared-v1");
      await fs.symlink(
        "../../shared/native.json",
        path.join(cwd, "profiles/group/current.json"),
        "file",
      );
      const [source] = await resolveFingerprintSourcePaths({
        cwd,
        includeDirectories: true,
        patterns: ["profiles/group"],
      });
      const before = await hashFingerprintSourcePath(source!);

      await fs.writeFile(path.join(cwd, "shared/native.json"), "shared-v2");

      const after = await hashFingerprintSourcePath(source!);
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a nested out-of-app symlink identity-only",
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "fingerprint-outside-"),
      );
      try {
        const target = path.join(outside, "native.json");
        await fs.writeFile(target, "outside-v1");
        await fs.symlink(
          target,
          path.join(cwd, "profiles/group/external.json"),
          "file",
        );
        const [source] = await resolveFingerprintSourcePaths({
          cwd,
          includeDirectories: true,
          patterns: ["profiles/group"],
        });
        const before = await hashFingerprintSourcePath(source!);

        await fs.writeFile(target, "outside-v2");

        const after = await hashFingerprintSourcePath(source!);
        expect(after.hash).toBe(before.hash);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows an explicitly named symlink using stat semantics",
    async () => {
      await fs.symlink(
        path.join(cwd, "profiles/native-a.json"),
        path.join(cwd, "linked-native.json"),
        "file",
      );
      const [source] = await resolveFingerprintSourcePaths({
        cwd,
        followSymbolicLinks: true,
        patterns: ["linked-native.json"],
      });
      expect(source).toMatchObject({
        filePath: "linked-native.json",
        type: "file",
      });
      const before = await hashFingerprintSourcePath(source!);

      await fs.writeFile(path.join(cwd, "profiles/native-a.json"), "linked-v2");

      const after = await hashFingerprintSourcePath(source!);
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlink target whose ancestor is replaced before open",
    async () => {
      const targetDirectory = path.join(cwd, "profiles/target");
      await fs.mkdir(targetDirectory);
      const target = path.join(targetDirectory, "native.json");
      await fs.writeFile(target, "trusted-native-config");
      const link = path.join(cwd, "linked-ancestor.json");
      await fs.symlink("profiles/target/native.json", link, "file");
      const [source] = await resolveFingerprintSourcePaths({
        cwd,
        followSymbolicLinks: true,
        patterns: ["linked-ancestor.json"],
      });
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "fingerprint-ancestor-secret-"),
      );
      let externalBytesRead = false;
      try {
        await fs.writeFile(
          path.join(outside, "native.json"),
          "external-secret",
        );
        const originalOpen = fs.open.bind(fs);
        let swapped = false;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (String(args[0]) === source!.resolvedLinkTarget && !swapped) {
            swapped = true;
            await fs.rename(targetDirectory, `${targetDirectory}-original`);
            await fs.symlink(outside, targetDirectory, "dir");
          }
          const handle = await originalOpen(...args);
          const originalReadFile = handle.readFile.bind(handle);
          vi.spyOn(handle, "readFile").mockImplementation(async () => {
            externalBytesRead = true;
            return originalReadFile();
          });
          return handle;
        });

        await expect(hashFingerprintSourcePath(source!)).rejects.toThrow(
          "Fingerprint source changed",
        );
        expect(externalBytesRead).toBe(false);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "hashes child changes beneath an explicitly named symlink directory",
    async () => {
      await fs.symlink(
        path.join(cwd, "profiles/group"),
        path.join(cwd, "linked-group"),
        "dir",
      );
      const [source] = await resolveFingerprintSourcePaths({
        cwd,
        followSymbolicLinks: true,
        includeDirectories: true,
        patterns: ["linked-group"],
      });
      expect(source).toMatchObject({ filePath: "linked-group", type: "dir" });
      const before = await hashFingerprintSourcePath(source!);

      await fs.writeFile(
        path.join(cwd, "profiles/group/config.txt"),
        "group-v3",
      );

      const after = await hashFingerprintSourcePath(source!);
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "hashes default-discovered symlink identity and confined target bytes",
    async () => {
      await fs.symlink(
        path.join(cwd, "profiles/native-a.json"),
        path.join(cwd, "linked-native.json"),
        "file",
      );
      const [source] = await resolveFingerprintSourcePaths({
        cwd,
        patterns: ["linked-native.json"],
      });
      const before = await hashFingerprintSourcePath(source!);

      await fs.writeFile(path.join(cwd, "profiles/native-a.json"), "linked-v3");

      const after = await hashFingerprintSourcePath(source!);
      expect(after.hash).not.toBe(before.hash);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an ordinary file replaced by an external symlink before hashing",
    async () => {
      const [source] = await resolveFingerprintSourcePaths({
        cwd,
        followSymbolicLinks: false,
        patterns: ["native.json"],
      });
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "fingerprint-secret-"),
      );
      try {
        const secret = path.join(outside, "secret.txt");
        await fs.writeFile(secret, "must-not-be-read");
        await fs.rm(path.join(cwd, "native.json"));
        await fs.symlink(secret, path.join(cwd, "native.json"), "file");
        const readFile = vi.spyOn(fs, "readFile");

        await expect(hashFingerprintSourcePath(source!)).rejects.toThrow();
        expect(readFile).not.toHaveBeenCalled();
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not read symlink targets outside the allowed root",
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "fingerprint-outside-"),
      );
      try {
        const target = path.join(outside, "native.json");
        await fs.writeFile(target, "outside-v1");
        await fs.symlink(
          target,
          path.join(cwd, "external-native.json"),
          "file",
        );
        const [source] = await resolveFingerprintSourcePaths({
          cwd,
          patterns: ["external-native.json"],
        });
        const before = await hashFingerprintSourcePath(source!);

        await fs.writeFile(target, "outside-v2");

        const after = await hashFingerprintSourcePath(source!);
        expect(after.hash).toBe(before.hash);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "hashes a cyclic symlink without traversing it",
    async () => {
      await fs.symlink("cycle-b", path.join(cwd, "cycle-a"));
      await fs.symlink("cycle-a", path.join(cwd, "cycle-b"));
      const sources = await resolveFingerprintSourcePaths({
        cwd,
        patterns: ["cycle-a"],
      });
      await expect(
        hashFingerprintSourcePath(sources[0]!),
      ).resolves.toMatchObject({
        byteSize: 7,
      });
    },
  );

  it("orders Unicode paths by UTF-16 code units", async () => {
    await Promise.all([
      fs.writeFile(path.join(cwd, "profiles/Z.json"), "upper"),
      fs.writeFile(path.join(cwd, "profiles/ä.json"), "non-ascii"),
    ]);

    const sources = await resolveFingerprintSourcePaths({
      cwd,
      patterns: ["profiles/{ä,Z}.json"],
    });

    expect(sources.map(({ filePath }) => filePath)).toEqual([
      "profiles/Z.json",
      "profiles/ä.json",
    ]);
  });
});
