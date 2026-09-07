import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readInfrastructureUpgradeFiles,
  renderInfrastructureUpgradeIndex,
} from "./upgradeFiles";

let directory: string;
const sections = [
  "Compatibility",
  "Steps",
  "Cloudflare",
  "Supabase",
  "AWS",
  "Firebase",
  "Verification",
];
const release = (version: string, emptySection?: string) =>
  `# ${version}\n\n${sections.map((heading) => `## ${heading}\n\n${heading === emptySection ? "" : `Instructions for ${heading} at ${version}.`}`).join("\n\n")}\n`;
const save = (version: string, content = release(version)) =>
  writeFile(path.join(directory, `${version}.md`), content);
const requirements = [
  { version: "1.0.0", note: "Initial infrastructure" },
  { version: "1.2.0", note: "Add a migration" },
  { version: "1.10.0", note: "Deploy the new runtime" },
];

beforeEach(async () => {
  directory = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-upgrade-files-"),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("versioned infrastructure release files", () => {
  it("keeps every release file intact and links skipped releases in semantic version order", async () => {
    for (const { version } of [...requirements].reverse()) await save(version);
    const files = await readInfrastructureUpgradeFiles(directory, requirements);
    expect(files.map(({ file }) => file)).toEqual([
      "1.0.0.md",
      "1.2.0.md",
      "1.10.0.md",
    ]);
    for (const file of files) expect(file.content).toBe(release(file.version));
    const index = renderInfrastructureUpgradeIndex(files);
    expect(index.indexOf("./1.0.0.md")).toBeLessThan(
      index.indexOf("./1.2.0.md"),
    );
    expect(index.indexOf("./1.2.0.md")).toBeLessThan(
      index.indexOf("./1.10.0.md"),
    );
    expect(index).toContain(
      "Read all relevant files before applying any changes",
    );
  });

  it("blocks a new doctor requirement without a file and an unregistered release file", async () => {
    await save("1.0.0");
    await expect(
      readInfrastructureUpgradeFiles(directory, requirements),
    ).rejects.toThrow("must match exactly");
    await save("1.2.0");
    await expect(
      readInfrastructureUpgradeFiles(directory, requirements.slice(0, 1)),
    ).rejects.toThrow("must match exactly");
  });

  it.each(sections)(
    "blocks a release with no %s instructions",
    async (section) => {
      await save("1.0.0", release("1.0.0", section));
      await expect(
        readInfrastructureUpgradeFiles(directory, requirements.slice(0, 1)),
      ).rejects.toThrow(`missing instructions for ${section}`);
    },
  );

  it("rejects out-of-order release registration and a file with the wrong version", async () => {
    for (const { version } of requirements) await save(version);
    await expect(
      readInfrastructureUpgradeFiles(directory, [...requirements].reverse()),
    ).rejects.toThrow("ascending versions");
    await save("1.2.0", release("1.1.0"));
    await expect(
      readInfrastructureUpgradeFiles(directory, requirements),
    ).rejects.toThrow("1.2.0.md needs its version heading");
  });
});
