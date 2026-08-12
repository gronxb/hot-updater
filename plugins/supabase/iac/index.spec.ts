import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePackageVersion } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCli, mockExeca } = vi.hoisted(() => ({
  mockCli: {
    p: {
      log: {
        error: vi.fn(),
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
      },
      confirm: vi.fn(),
      isCancel: vi.fn(() => false),
      select: vi.fn(),
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
      tasks: vi.fn(
        async (
          tasks: {
            task: (message: (value: string) => void) => Promise<unknown>;
          }[],
        ) => {
          for (const task of tasks) {
            await task.task(vi.fn());
          }
        },
      ),
    },
  },
  mockExeca: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    p: mockCli.p,
  };
});

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("execa")>();
  return {
    ...actual,
    execa: mockExeca,
  };
});

import {
  createSelectedBucket,
  getSupabaseProjectAccess,
  getLegacySupabaseConfigReference,
  resolveEdgeFunctionDenoConfig,
  selectBucket,
  selectProject,
  waitForSupabaseProjectReady,
} from "./index";
import type { SupabaseApi } from "./supabaseApi";
import {
  confirmSupabaseDatabaseMigrations,
  linkSupabase,
  pushDB,
} from "./supabaseCli";
import type { SupabaseManagementApi } from "./supabaseManagementApi";

const createExecaError = async (
  command: readonly string[],
  stderr = "failed SASL auth: password authentication failed",
) => {
  const actual = await vi.importActual<typeof import("execa")>("execa");

  try {
    await actual.execa(command[0] ?? "node", command.slice(1));
  } catch (error) {
    if (error instanceof Error) {
      Object.defineProperty(error, "stderr", { value: stderr });
      return error;
    }

    throw error;
  }

  throw new Error("Expected command to fail");
};

const expectExit = () => {
  vi.spyOn(process, "exit").mockImplementation((c) => {
    throw new Error(`process.exit(${c})`);
  });
};

const collectUserFacingErrorOutput = () => [
  ...mockCli.p.log.error.mock.calls.flat(),
  ...vi.mocked(console.error).mock.calls.flat(),
];

describe("getLegacySupabaseConfigReference", () => {
  it("detects legacy Supabase env references", () => {
    expect(
      getLegacySupabaseConfigReference(
        "process.env.HOT_UPDATER_SUPABASE_ANON_KEY!",
      ),
    ).toBe("HOT_UPDATER_SUPABASE_ANON_KEY");
  });

  it("detects legacy Supabase config fields", () => {
    expect(
      getLegacySupabaseConfigReference(
        "supabaseDatabase({ supabaseAnonKey: legacyKey })",
      ),
    ).toBe("supabaseAnonKey");
  });

  it("allows service-role Supabase config", () => {
    expect(
      getLegacySupabaseConfigReference(
        "supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!",
      ),
    ).toBeNull();
  });
});

describe("selectProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prompts with a saved project selected by default in interactive mode", async () => {
    // Given
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([
        {
          id: "saved-project",
          name: "Saved project",
          region: "ap-northeast-2",
        },
      ]),
    });
    mockCli.p.select.mockResolvedValue("saved-project");

    // When
    const project = await selectProject("saved-project");

    // Then
    expect(project).toEqual({
      create: false,
      project: {
        id: "saved-project",
        name: "Saved project",
        region: "ap-northeast-2",
      },
    });
    expect(mockCli.p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "saved-project",
      }),
    );
  });

  it("reuses a saved project without prompting in non-interactive mode", async () => {
    // Given
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([
        {
          id: "saved-project",
          name: "Saved project",
          region: "ap-northeast-2",
        },
      ]),
    });

    // When
    const project = await selectProject("saved-project", true);

    // Then
    expect(project).toEqual({
      create: false,
      project: {
        id: "saved-project",
        name: "Saved project",
        region: "ap-northeast-2",
      },
    });
    expect(mockCli.p.select).not.toHaveBeenCalled();
  });

  it("prompts with the only available project selected by default", async () => {
    // Given
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([
        {
          id: "only-project",
          name: "Only project",
          region: "ap-northeast-2",
        },
      ]),
    });
    mockCli.p.select.mockResolvedValue("only-project");

    // When
    const project = await selectProject();

    // Then
    expect(project).toEqual({
      create: false,
      project: {
        id: "only-project",
        name: "Only project",
        region: "ap-northeast-2",
      },
    });
    expect(mockCli.p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "only-project",
      }),
    );
  });

  it("prompts instead of replacing a missing saved project with a singleton", async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([
        {
          id: "only-project",
          name: "Only project",
          region: "ap-northeast-2",
        },
      ]),
    });
    mockCli.p.select.mockResolvedValue("only-project");

    await expect(selectProject("deleted-project")).resolves.toEqual({
      create: false,
      project: {
        id: "only-project",
        name: "Only project",
        region: "ap-northeast-2",
      },
    });
    expect(mockCli.p.select).toHaveBeenCalledOnce();
  });

  it("plans project creation without provisioning during selection", async () => {
    mockExeca.mockResolvedValue({ stdout: "[]" });
    mockCli.p.select.mockImplementation(async ({ options }) => {
      return options.at(-1)?.value;
    });

    await expect(selectProject()).resolves.toEqual({ create: true });
    expect(mockExeca).toHaveBeenCalledOnce();
    expect(mockExeca).not.toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["projects", "create"]),
      expect.anything(),
    );
  });
});

describe("selectBucket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prompts with a saved bucket selected by default in interactive mode", async () => {
    // Given
    const api: SupabaseApi = {
      createBucket: vi.fn(),
      listBuckets: vi.fn().mockResolvedValue([
        {
          createdAt: "2026-07-26",
          id: "public-bucket-id",
          isPublic: true,
          name: "public-bucket",
        },
      ]),
      updateBucket: vi.fn(),
    };
    mockCli.p.select.mockResolvedValue("public-bucket-id");

    // When
    const selection = await selectBucket(api, "public-bucket");

    // Then
    expect(selection).toEqual({
      create: false,
      id: "public-bucket-id",
      isPublic: true,
      name: "public-bucket",
    });
    expect(mockCli.p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "public-bucket-id",
      }),
    );
  });

  it("reuses a saved bucket without prompting in non-interactive mode", async () => {
    // Given
    const api: SupabaseApi = {
      createBucket: vi.fn(),
      listBuckets: vi.fn().mockResolvedValue([
        {
          createdAt: "2026-07-26",
          id: "private-bucket-id",
          isPublic: false,
          name: "private-bucket",
        },
      ]),
      updateBucket: vi.fn(),
    };

    // When
    const selection = await selectBucket(api, "private-bucket", true);

    // Then
    expect(selection).toEqual({
      create: false,
      id: "private-bucket-id",
      isPublic: false,
      name: "private-bucket",
    });
    expect(mockCli.p.select).not.toHaveBeenCalled();
  });

  it("plans a missing saved bucket before creating it", async () => {
    const api: SupabaseApi = {
      createBucket: vi.fn().mockResolvedValue({ name: "saved-bucket" }),
      listBuckets: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            createdAt: "2026-07-26",
            id: "saved-bucket-id",
            isPublic: false,
            name: "saved-bucket",
          },
        ]),
      updateBucket: vi.fn(),
    };

    const selection = await selectBucket(api, "saved-bucket", true);

    expect(selection).toEqual({
      create: true,
      name: "saved-bucket",
    });
    expect(api.createBucket).not.toHaveBeenCalled();

    await expect(createSelectedBucket(api, selection)).resolves.toEqual({
      id: "saved-bucket-id",
      name: "saved-bucket",
    });
    expect(api.createBucket).toHaveBeenCalledWith("saved-bucket", {
      public: false,
    });
  });
});

describe("Supabase project readiness", () => {
  const project = {
    id: "project-ref",
    name: "Hot Updater",
    region: "us-east-1",
  };
  const createManagementApi = (): SupabaseManagementApi => ({
    createProject: vi.fn(),
    getProjectStatus: vi.fn(),
    listOrganizations: vi.fn(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers from the recognized provisioning status", async () => {
    vi.useFakeTimers();
    const getProjectStatus = vi
      .fn()
      .mockResolvedValueOnce("COMING_UP")
      .mockResolvedValueOnce("ACTIVE_HEALTHY");
    const readiness = waitForSupabaseProjectReady({
      getProjectStatus,
      onLongWait: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1000);

    await expect(readiness).resolves.toBeUndefined();
    expect(getProjectStatus).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when the status request is unauthorized", async () => {
    const getProjectStatus = vi
      .fn()
      .mockRejectedValue(new Error("Management API status 401"));

    await expect(
      waitForSupabaseProjectReady({
        getProjectStatus,
        onLongWait: vi.fn(),
      }),
    ).rejects.toThrow("Management API status 401");
    expect(getProjectStatus).toHaveBeenCalledOnce();
  });

  it("fails immediately for an unexpected project status", async () => {
    const getProjectStatus = vi.fn().mockResolvedValue("INACTIVE");

    await expect(
      waitForSupabaseProjectReady({
        getProjectStatus,
        onLongWait: vi.fn(),
      }),
    ).rejects.toThrow("Supabase project entered unexpected status: INACTIVE.");
    expect(getProjectStatus).toHaveBeenCalledOnce();
  });

  it("retains the last provisioning status in timeout errors", async () => {
    vi.useFakeTimers();
    const getProjectStatus = vi.fn().mockResolvedValue("COMING_UP");
    const readiness = waitForSupabaseProjectReady({
      getProjectStatus,
      maxAttempts: 2,
      onLongWait: vi.fn(),
      pollIntervalMs: 1000,
    });
    const assertion = expect(readiness).rejects.toThrow(
      "Last status: COMING_UP.",
    );

    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it("uses stored Supabase CLI credentials to get project access when no token is provided", async () => {
    const managementApi = createManagementApi();
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify([
        { api_key: "service-role-key", name: "service_role" },
      ]),
    });

    await expect(
      getSupabaseProjectAccess({
        accessToken: undefined,
        managementApi,
        project,
        waitForProject: false,
      }),
    ).resolves.toEqual({
      api: expect.any(Object),
      serviceRoleApiKey: "service-role-key",
    });
    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      [
        "-y",
        "supabase",
        "projects",
        "api-keys",
        "--project-ref",
        "project-ref",
        "--output",
        "json",
      ],
      { env: undefined },
    );
  });

  it("surfaces CLI failures immediately after the project is ready", async () => {
    const managementApi = createManagementApi();
    vi.mocked(managementApi.getProjectStatus).mockResolvedValue(
      "ACTIVE_HEALTHY",
    );
    mockExeca.mockRejectedValue(new Error("Supabase CLI authorization failed"));

    await expect(
      getSupabaseProjectAccess({
        accessToken: "access-token",
        managementApi,
        project,
        waitForProject: true,
      }),
    ).rejects.toThrow("Supabase CLI authorization failed");
    expect(mockExeca).toHaveBeenCalledOnce();
  });

  it("surfaces malformed API key JSON immediately", async () => {
    const managementApi = createManagementApi();
    vi.mocked(managementApi.getProjectStatus).mockResolvedValue(
      "ACTIVE_HEALTHY",
    );
    mockExeca.mockResolvedValue({ stdout: "not-json" });

    await expect(
      getSupabaseProjectAccess({
        accessToken: "access-token",
        managementApi,
        project,
        waitForProject: true,
      }),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(mockExeca).toHaveBeenCalledOnce();
  });
});

describe("Supabase database migration confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks before migrating an existing project interactively", async () => {
    // Given
    mockCli.p.confirm.mockResolvedValue(false);

    // When
    const confirmed = await confirmSupabaseDatabaseMigrations({
      nonInteractive: false,
    });

    // Then
    expect(confirmed).toBe(false);
    expect(mockCli.p.confirm).toHaveBeenCalledOnce();
  });

  it("asks before migrating a new project interactively", async () => {
    // Given
    mockCli.p.confirm.mockResolvedValue(false);

    // When
    const confirmed = await confirmSupabaseDatabaseMigrations({
      nonInteractive: false,
    });

    // Then
    expect(confirmed).toBe(false);
    expect(mockCli.p.confirm).toHaveBeenCalledOnce();
  });

  it("continues without prompting for a non-interactive init", async () => {
    // Given
    mockCli.p.confirm.mockResolvedValue(false);

    // When
    const confirmed = await confirmSupabaseDatabaseMigrations({
      nonInteractive: true,
    });

    // Then
    expect(confirmed).toBe(true);
    expect(mockCli.p.confirm).not.toHaveBeenCalled();
  });
});

describe("Supabase CLI authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses stored CLI credentials when linking without an access token", async () => {
    const workdir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-supabase-link-"),
    );
    await fs.mkdir(path.join(workdir, "supabase"), { recursive: true });
    mockExeca.mockResolvedValue({ stdout: "" });

    try {
      await linkSupabase(workdir, {
        projectId: "project-ref",
      });

      expect(mockExeca).toHaveBeenCalledWith(
        "npx",
        [
          "supabase",
          "link",
          "--project-ref",
          "project-ref",
          "--workdir",
          workdir,
        ],
        expect.objectContaining({
          env: undefined,
        }),
      );
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("uses stored CLI credentials when pushing migrations without an access token", async () => {
    mockExeca.mockResolvedValue({ stdout: "" });

    await pushDB("/tmp/hot-updater-supabase-push", {});

    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      ["supabase", "db", "push", "--include-all", "--yes"],
      expect.objectContaining({
        env: undefined,
      }),
    );
  });
});

describe("Supabase database password failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes confirmation through the Hot Updater prompt instead of the Supabase CLI", async () => {
    // Given
    mockExeca.mockResolvedValue({ stdout: "" });

    // When
    await pushDB("/tmp/hot-updater-supabase-push", {
      accessToken: "test-access-token",
    });

    // Then
    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      ["supabase", "db", "push", "--include-all", "--yes"],
      expect.anything(),
    );
  });

  it("prints a sanitized auth message when Supabase link fails with a database password", async () => {
    // Given
    const secret = "!Uh3cfmde";
    const workdir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-supabase-link-"),
    );
    await fs.mkdir(path.join(workdir, "supabase"), { recursive: true });
    const error = await createExecaError([
      "node",
      "-e",
      "process.exit(1)",
      "--password",
      secret,
    ]);
    mockExeca.mockRejectedValue(error);
    expectExit();

    try {
      // When
      await expect(
        linkSupabase(workdir, {
          accessToken: "test-access-token",
          dbPassword: secret,
          projectId: "project-ref",
        }),
      ).rejects.toThrow("process.exit(1)");

      // Then
      const output = collectUserFacingErrorOutput().join("\n");
      expect(output).toContain("Supabase database connection failed");
      expect(output).not.toContain(secret);
      expect(output).not.toContain("--password");
      expect(mockExeca).toHaveBeenCalledWith(
        "npx",
        [
          "supabase",
          "link",
          "--project-ref",
          "project-ref",
          "--workdir",
          workdir,
        ],
        expect.objectContaining({
          env: {
            SUPABASE_ACCESS_TOKEN: "test-access-token",
            SUPABASE_DB_PASSWORD: secret,
          },
        }),
      );
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("prints Supabase stderr when link fails for a non-auth reason", async () => {
    // Given
    const secret = "!Uh3cfmde";
    const workdir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-supabase-link-"),
    );
    await fs.mkdir(path.join(workdir, "supabase"), { recursive: true });
    const error = await createExecaError(
      ["node", "-e", "process.exit(1)"],
      "Unexpected Supabase CLI failure",
    );
    mockExeca.mockRejectedValue(error);
    expectExit();

    try {
      // When
      await expect(
        linkSupabase(workdir, {
          accessToken: "test-access-token",
          dbPassword: secret,
          projectId: "project-ref",
        }),
      ).rejects.toThrow("process.exit(1)");

      // Then
      const output = collectUserFacingErrorOutput().join("\n");
      expect(output).toContain("Unexpected Supabase CLI failure");
      expect(output).not.toContain("Supabase database connection failed");
      expect(output).not.toContain(secret);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("prints a sanitized auth message when Supabase db push fails with a database password", async () => {
    // Given
    const secret = "!Uh3cfmde";
    const error = await createExecaError([
      "node",
      "-e",
      "process.exit(1)",
      "--password",
      secret,
    ]);
    mockExeca.mockRejectedValue(error);
    expectExit();

    // When
    await expect(
      pushDB("/tmp/hot-updater-supabase-push", {
        accessToken: "test-access-token",
        dbPassword: secret,
      }),
    ).rejects.toThrow("process.exit(1)");

    // Then
    const output = collectUserFacingErrorOutput().join("\n");
    expect(output).toContain("Supabase database connection failed");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("--password");
    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      ["supabase", "db", "push", "--include-all", "--yes"],
      expect.objectContaining({
        env: {
          SUPABASE_ACCESS_TOKEN: "test-access-token",
          SUPABASE_DB_PASSWORD: secret,
        },
        stderr: ["pipe", "inherit"],
        stdin: "inherit",
        stdout: "inherit",
      }),
    );
  });

  it.each([
    [
      "postgres auth SQLSTATE",
      "FATAL: password authentication failed (SQLSTATE 28P01)",
    ],
    ["Supabase SCRAM auth failure", "invalid SCRAM server-final-message"],
  ])("prints a sanitized auth message for %s", async (_name, stderr) => {
    // Given
    const secret = "!Uh3cfmde";
    const error = await createExecaError(
      ["node", "-e", "process.exit(1)", "--password", secret],
      stderr,
    );
    mockExeca.mockRejectedValue(error);
    expectExit();

    // When
    await expect(
      pushDB("/tmp/hot-updater-supabase-push", {
        accessToken: "test-access-token",
        dbPassword: secret,
      }),
    ).rejects.toThrow("process.exit(1)");

    // Then
    const output = collectUserFacingErrorOutput().join("\n");
    expect(output).toContain("Supabase database connection failed");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("--password");
  });

  it("does not replace Supabase db push non-auth failures with the auth message", async () => {
    // Given
    const secret = "!Uh3cfmde";
    const error = await createExecaError(
      ["node", "-e", "process.exit(1)"],
      "Remote migration failed",
    );
    mockExeca.mockRejectedValue(error);
    expectExit();

    // When
    await expect(
      pushDB("/tmp/hot-updater-supabase-push", {
        accessToken: "test-access-token",
        dbPassword: secret,
      }),
    ).rejects.toThrow("process.exit(1)");

    // Then
    const output = collectUserFacingErrorOutput().join("\n");
    expect(output).not.toContain("Supabase database connection failed");
    expect(output).not.toContain(secret);
    expect(mockCli.p.log.error).toHaveBeenCalledWith(error.message);
  });
});

describe("resolveEdgeFunctionDenoConfig", () => {
  it("vendors package dist files into the edge function directory", async () => {
    const targetDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-supabase-edge-"),
    );
    try {
      const result = await resolveEdgeFunctionDenoConfig(targetDir);

      expect(result.imports).toEqual({
        "@hot-updater/server":
          "./_hot-updater/hot-updater-server/dist/index.mjs",
        "@hot-updater/supabase/edge":
          "./_hot-updater/hot-updater-supabase/dist/edge.mjs",
        "@hot-updater/core": "./_hot-updater/hot-updater-core/dist/index.mjs",
        "@hot-updater/js": "./_hot-updater/hot-updater-js/dist/index.mjs",
        "@hot-updater/plugin-core":
          "./_hot-updater/hot-updater-plugin-core/dist/index.mjs",
        "@hot-updater/plugin-core/internal":
          "./_hot-updater/hot-updater-plugin-core/dist/internal.mjs",
        "@supabase/supabase-js": `npm:@supabase/supabase-js@${resolvePackageVersion(
          "@supabase/supabase-js",
          {
            searchFrom: path.resolve("plugins/supabase"),
          },
        )}`,
        mime: `npm:mime@${resolvePackageVersion("mime", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
        verkit: `npm:verkit@${resolvePackageVersion("verkit", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
      });

      await expect(
        fs.readFile(
          path.join(
            targetDir,
            "_hot-updater/hot-updater-server/dist/index.mjs",
          ),
          "utf8",
        ),
      ).resolves.toContain("./handler.mjs");

      await expect(
        fs.readFile(
          path.join(
            targetDir,
            "_hot-updater/hot-updater-supabase/dist/edge.mjs",
          ),
          "utf8",
        ),
      ).resolves.toMatch(
        /export \{[^}]*\bsupabaseDatabase\b[^}]*\bsupabaseStorage\b[^}]*\}/,
      );
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
