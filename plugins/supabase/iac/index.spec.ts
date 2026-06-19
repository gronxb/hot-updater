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
      },
      spinner: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
      })),
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
  getLegacySupabaseConfigReference,
  linkSupabase,
  pushDB,
  resolveEdgeFunctionDenoConfig,
} from "./index";

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

describe("Supabase database password failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
          env: { SUPABASE_DB_PASSWORD: secret },
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
      pushDB("/tmp/hot-updater-supabase-push", { dbPassword: secret }),
    ).rejects.toThrow("process.exit(1)");

    // Then
    const output = collectUserFacingErrorOutput().join("\n");
    expect(output).toContain("Supabase database connection failed");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("--password");
    expect(mockExeca).toHaveBeenCalledWith(
      "npx",
      ["supabase", "db", "push", "--include-all"],
      expect.objectContaining({
        env: { SUPABASE_DB_PASSWORD: secret },
        stderr: ["pipe", "inherit"],
        stdin: "inherit",
        stdout: "inherit",
      }),
    );
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
      pushDB("/tmp/hot-updater-supabase-push", { dbPassword: secret }),
    ).rejects.toThrow("process.exit(1)");

    // Then
    const output = collectUserFacingErrorOutput().join("\n");
    expect(output).not.toContain("Supabase database connection failed");
    expect(output).not.toContain(secret);
    expect(console.error).toHaveBeenCalledWith(error);
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
        "@hot-updater/server/runtime":
          "./_hot-updater/hot-updater-server/dist/runtime.mjs",
        "@hot-updater/supabase":
          "./_hot-updater/hot-updater-supabase/dist/edge.mjs",
        "@hot-updater/core": "./_hot-updater/hot-updater-core/dist/index.mjs",
        "@hot-updater/js": "./_hot-updater/hot-updater-js/dist/index.mjs",
        "@hot-updater/plugin-core":
          "./_hot-updater/hot-updater-plugin-core/dist/index.mjs",
        "@supabase/supabase-js": `npm:@supabase/supabase-js@${resolvePackageVersion(
          "@supabase/supabase-js",
          {
            searchFrom: path.resolve("plugins/supabase"),
          },
        )}`,
        "es-toolkit": `npm:es-toolkit@${resolvePackageVersion("es-toolkit", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
        mime: `npm:mime@${resolvePackageVersion("mime", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
        semver: `npm:semver@${resolvePackageVersion("semver", {
          searchFrom: path.resolve("plugins/plugin-core"),
        })}`,
      });

      await expect(
        fs.readFile(
          path.join(
            targetDir,
            "_hot-updater/hot-updater-server/dist/runtime.mjs",
          ),
          "utf8",
        ),
      ).resolves.toContain("./handler.mjs");

      const supabaseDistFiles = await fs.readdir(
        path.join(targetDir, "_hot-updater/hot-updater-supabase/dist"),
      );
      expect(
        supabaseDistFiles.some(
          (file) =>
            file.startsWith("supabaseEdgeFunctionStorage-") &&
            file.endsWith(".mjs"),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
