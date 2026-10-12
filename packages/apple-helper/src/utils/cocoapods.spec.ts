import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { installPodsIfNeeded } from "./cocoapods";

const mocks = vi.hoisted(() => ({ cwd: "", execa: vi.fn(async () => ({})) }));
vi.mock("execa", () => ({ execa: mocks.execa }));
vi.mock("@hot-updater/cli-tools", () => ({
  getCwd: () => mocks.cwd,
  p: {
    log: { info: vi.fn() },
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  },
}));
afterEach(async () => {
  if (mocks.cwd) await fs.rm(mocks.cwd, { recursive: true, force: true });
  vi.clearAllMocks();
});

it.each([
  { bundler: false, environment: undefined },
  { bundler: true, environment: undefined },
  { bundler: false, environment: { RCT_USE_RN_DEP: "1" } },
  { bundler: true, environment: { RCT_USE_RN_DEP: "0" } },
])(
  "installs a Podfile using only the supplied integration environment: %j",
  async ({ bundler, environment }) => {
    mocks.cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-pods-"));
    const ios = path.join(mocks.cwd, "ios");
    await fs.mkdir(ios);
    await fs.writeFile(path.join(ios, "Podfile"), "platform :ios, '15.0'\n");
    if (bundler)
      await fs.writeFile(path.join(mocks.cwd, "Gemfile"), 'gem "cocoapods"\n');

    await installPodsIfNeeded(ios, environment);

    expect(mocks.execa).toHaveBeenLastCalledWith(
      bundler ? "bundle" : "pod",
      bundler ? ["exec", "pod", "install"] : ["install"],
      { cwd: ios, env: environment },
    );
  },
);
