import { HotUpdateDirUtil } from "@hot-updater/core";
import { mockReactNativeProjectRoot } from "@hot-updater/test-utils/node";
import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it } from "vitest";
import { appendToProjectRootGitignore } from "./git";

describe("appendToProjectRootGitignore", () => {
  let rootDir: string;
  const gitIgnorePath = () => path.join(rootDir, ".gitignore");

  beforeEach(async () => {
    const mockedProject = await mockReactNativeProjectRoot({
      example: "rn-77",
    });
    rootDir = mockedProject.rootDir;
  }, 5000);

  it(".gitignore won't be generated if globLines is empty", () => {
    fs.rmSync(gitIgnorePath());

    appendToProjectRootGitignore({
      cwd: rootDir,
      globLines: [],
    });

    expect(fs.existsSync(gitIgnorePath())).toBe(false);
  });

  it(".gitignore is generated if doesn't exist", () => {
    fs.rmSync(gitIgnorePath());

    appendToProjectRootGitignore({
      cwd: rootDir,
      globLines: [HotUpdateDirUtil.outputGitignorePath],
    });

    expect(fs.readFileSync(gitIgnorePath(), { encoding: "utf8" })).toBe(
      `# hot-updater
${HotUpdateDirUtil.outputGitignorePath}
`,
    );
  });

  it("don't add duplicated lines", () => {
    const line = "hello world!";
    expect(
      appendToProjectRootGitignore({
        cwd: rootDir,
        globLines: [line],
      }),
    ).toBe(true);

    expect(
      appendToProjectRootGitignore({
        cwd: rootDir,
        globLines: [line],
      }),
    ).toBe(false);
  });
});
