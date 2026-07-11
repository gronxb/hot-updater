import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyDirToTmp: vi.fn(),
  createWrangler: vi.fn(),
  getCwd: vi.fn(),
  getWranglerLoginAuthToken: vi.fn(),
  makeEnv: vi.fn(),
  writeHotUpdaterConfig: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  type MockTask = { task: () => Promise<unknown> | unknown };
  const log = {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  };
  return {
    ...actual,
    copyDirToTmp: mocks.copyDirToTmp,
    getCwd: mocks.getCwd,
    makeEnv: mocks.makeEnv,
    p: {
      confirm: vi.fn(),
      isCancel: vi.fn(() => false),
      log,
      note: vi.fn(),
      password: vi.fn(),
      select: vi.fn(),
      tasks: vi.fn(async (tasks: MockTask[]) => {
        for (const task of tasks) {
          await task.task();
        }
      }),
      text: vi.fn(),
    },
    writeHotUpdaterConfig: mocks.writeHotUpdaterConfig,
  };
});

vi.mock("cloudflare", () => ({
  Cloudflare: class {
    readonly d1 = {
      database: {
        list: vi.fn(async () => ({
          result: [{ name: "hot-updater", uuid: "database-id" }],
        })),
      },
    };

    readonly workers = {
      subdomains: {
        get: vi.fn(async () => ({ subdomain: "example" })),
      },
    };
  },
}));

vi.mock("./getWranglerLoginAuthToken", () => ({
  getWranglerLoginAuthToken: mocks.getWranglerLoginAuthToken,
}));

vi.mock("../src/utils/createWrangler", () => ({
  createWrangler: mocks.createWrangler,
}));

import { runInit } from "./index";

const tempDirs: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  const projectRoot = await fs.mkdtemp(
    path.join(process.cwd(), ".cloudflare-iac-project-"),
  );
  const packageCopyRoot = await fs.mkdtemp(
    path.join(process.cwd(), ".cloudflare-iac-package-"),
  );
  tempDirs.push(projectRoot, packageCopyRoot);
  await fs.writeFile(
    path.join(projectRoot, ".env.hotupdater"),
    [
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID=account-id",
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN=api-token",
      "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME=bucket-name",
      "HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID=access-key-id",
      "HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY=secret-access-key",
      "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID=database-id",
      "HOT_UPDATER_CLOUDFLARE_WORKER_NAME=worker-name",
      "",
    ].join("\n"),
  );
  await fs.mkdir(path.join(packageCopyRoot, "worker", "migrations"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(packageCopyRoot, "worker", "wrangler.json"),
    JSON.stringify({}),
  );

  mocks.getCwd.mockReturnValue(projectRoot);
  mocks.getWranglerLoginAuthToken.mockReturnValue({
    expiration_time: "2999-01-01T00:00:00.000Z",
    oauth_token: "oauth-token",
  });
  mocks.copyDirToTmp.mockResolvedValue({
    removeTmpDir: vi.fn(async () => {}),
    tmpDir: packageCopyRoot,
  });
  mocks.createWrangler.mockResolvedValue(vi.fn(async () => {}));
  mocks.writeHotUpdaterConfig.mockResolvedValue({
    path: path.join(projectRoot, "hot-updater.config.ts"),
    status: "created",
  });
});

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Cloudflare managed config scaffold", () => {
  it("generates a Node D1 database configured from managed credentials", async () => {
    // Given
    const build = "bare";

    // When
    await runInit({ build });

    // Then
    expect(mocks.writeHotUpdaterConfig).toHaveBeenCalledOnce();
    const scaffold = mocks.writeHotUpdaterConfig.mock.calls[0]?.[0];
    expect(scaffold?.text).toContain(
      'import { d1Database, r2Storage } from "@hot-updater/cloudflare";',
    );
    expect(scaffold?.text).not.toContain("@hot-updater/cloudflare/worker");
    expect(scaffold?.text).toContain(
      "databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!",
    );
    expect(scaffold?.text).toContain(
      "accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!",
    );
    expect(scaffold?.text).toContain(
      "cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!",
    );
  });
});
