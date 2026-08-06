import { beforeEach, describe, expect, it, vi } from "vitest";

type InstallTask = {
  readonly enabled: boolean;
  readonly task: (message: (value: string) => void) => Promise<unknown>;
};

const mocks = vi.hoisted(() => ({
  execa: vi.fn(),
  readPackageUp: vi.fn(),
  tasks: vi.fn(),
}));

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return { ...actual, execa: mocks.execa };
});

vi.mock("./getPackageManager.js", () => ({
  getPackageManager: () => "pnpm",
}));

vi.mock("./prompts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prompts.js")>();
  return { p: { ...actual.p, tasks: mocks.tasks } };
});

vi.mock("./readPackageUp.js", () => ({
  readPackageUp: mocks.readPackageUp,
}));

import { ensureInstallPackages } from "./ensureInstallPackages";

describe("ensureInstallPackages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execa.mockResolvedValue({ exitCode: 0, stderr: "" });
    mocks.tasks.mockImplementation(async (tasks: readonly InstallTask[]) => {
      for (const task of tasks) {
        if (task.enabled) {
          await task.task(() => {});
        }
      }
    });
  });

  it("does not reinstall a dependency already declared as a dev dependency", async () => {
    mocks.readPackageUp.mockResolvedValue({
      packageJson: {
        devDependencies: {
          "@hot-updater/react-native": "^0.35.8",
        },
      },
      path: "/project/package.json",
    });

    await ensureInstallPackages({
      dependencies: ["@hot-updater/react-native"],
    });

    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
