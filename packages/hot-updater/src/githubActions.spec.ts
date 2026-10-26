import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getLocalKeyFile,
  maskSecretValues,
  readLocalKey,
  writeLocalKey,
} from "@hot-updater/cli-tools";
import sodium from "libsodium-wrappers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { githubActions } from "./githubActions";

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

const USER_TOKEN = "gho_specUserTokenFromGhCli000000000000";
const PAT = "github_pat_specFineGrainedToken0000000000";
const WORKFLOW_TOKEN = "ghs_specWorkflowToken00000000000000000";

let directory: string;
let keyPair: { publicKey: Uint8Array; privateKey: Uint8Array };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A GitHub API that answers the public key and records each PUT. */
const stubGitHub = ({
  keyStatus = 200,
  putStatus = 201,
  headers = {},
}: {
  readonly keyStatus?: number;
  readonly putStatus?: number;
  readonly headers?: Record<string, string>;
} = {}) => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/public-key")) {
        return keyStatus === 200
          ? Response.json({
              key_id: "568250167242549743",
              key: sodium.to_base64(
                keyPair.publicKey,
                sodium.base64_variants.ORIGINAL,
              ),
            })
          : Response.json(
              { message: "Not Found" },
              { status: keyStatus, headers },
            );
      }
      return putStatus < 300
        ? new Response(null, { status: putStatus })
        : Response.json(
            { message: "Resource not accessible by integration" },
            { status: putStatus, headers },
          );
    }),
  );
  return calls;
};

/** Opens a PUT body's sealed box with libsodium, as GitHub does. */
const openPut = (call: Call) => {
  const body = JSON.parse(String(call.init.body)) as {
    encrypted_value: string;
    key_id: string;
  };
  const opened = sodium.crypto_box_seal_open(
    sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
    keyPair.publicKey,
    keyPair.privateKey,
  );
  return { keyId: body.key_id, value: sodium.to_string(opened) };
};

const gitRemote = (url: string | undefined) =>
  execaMock.mockImplementation(
    async (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv; extendEnv?: boolean } = {},
    ) => {
      if (file === "git" && args.join(" ") === "remote get-url origin") {
        return url === undefined
          ? {
              exitCode: 2,
              stdout: "",
              stderr: "error: No such remote 'origin'",
            }
          : { exitCode: 0, stdout: `${url}\n`, stderr: "" };
      }
      if (file === "gh" && args.join(" ") === "auth token") {
        // As gh does: GH_TOKEN, then GITHUB_TOKEN, win over the stored login.
        const env =
          options.extendEnv === false
            ? (options.env ?? {})
            : { ...process.env, ...options.env };
        const token = env["GH_TOKEN"] || env["GITHUB_TOKEN"] || USER_TOKEN;
        return { exitCode: 0, stdout: `${token}\n`, stderr: "" };
      }
      throw new Error(`unexpected command ${file} ${args.join(" ")}`);
    },
  );

const ghCalls = () =>
  execaMock.mock.calls.filter(([file]) => file === "gh").length;

beforeAll(async () => {
  await sodium.ready;
  // A fixed key pair, so a failure reproduces.
  keyPair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(7));
});

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-gha-"));
  vi.stubEnv("HOT_UPDATER_HOME", path.join(directory, "home"));
  // The runner's own CI and GitHub variables must not leak into the spec.
  vi.stubEnv("CI", undefined);
  vi.stubEnv("GITHUB_ACTIONS", undefined);
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  gitRemote("https://github.com/acme/app.git");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  execaMock.mockReset();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("githubActions set", () => {
  it("seals the value for the repository's public key and stores it under its variable name", async () => {
    const calls = stubGitHub();
    const value = JSON.stringify({ keyId: "ABC123", p8: "-----BEGIN…" });

    await githubActions().set!("asc-api-key", value, { cwd: directory });

    expect(calls.map(({ url, init }) => [init.method ?? "GET", url])).toEqual([
      [
        "GET",
        "https://api.github.com/repos/acme/app/actions/secrets/public-key",
      ],
      [
        "PUT",
        "https://api.github.com/repos/acme/app/actions/secrets/HOT_UPDATER_ASC_API_KEY",
      ],
    ]);
    for (const { init } of calls) {
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${USER_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      });
    }
    expect(openPut(calls[1]!)).toEqual({ keyId: "568250167242549743", value });
    // And keeps a copy on this machine, which builds here read.
    expect(await readLocalKey("asc-api-key", directory)).toBe(value);
    if (process.platform !== "win32") {
      expect(
        (await fs.stat(getLocalKeyFile("asc-api-key", directory))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("keeps no copy on this machine when GitHub refuses the write", async () => {
    stubGitHub({ putStatus: 403 });

    await expect(
      githubActions().set!("asc-api-key", "value", { cwd: directory }),
    ).rejects.toThrow("Could not store HOT_UPDATER_ASC_API_KEY in acme/app");

    expect(await readLocalKey("asc-api-key", directory)).toBeUndefined();
  });

  it("reports a copy it could not keep, without failing the write GitHub took", async () => {
    const calls = stubGitHub();
    // A file where the key store's directory goes.
    await fs.writeFile(path.join(directory, "home"), "");

    await expect(
      githubActions().set!("asc-api-key", "value", { cwd: directory }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
  });

  it("seals each write with a fresh ephemeral key", async () => {
    const calls = stubGitHub();
    const secrets = githubActions({ repo: "acme/app" });

    await secrets.set!("TOKEN_A", "same value", { cwd: directory });
    await secrets.set!("TOKEN_A", "same value", { cwd: directory });

    const [first, second] = calls
      .filter(({ init }) => init.method === "PUT")
      .map(({ init }) => JSON.parse(String(init.body)).encrypted_value);
    expect(first).not.toBe(second);
    expect(openPut(calls[1]!).value).toBe("same value");
    expect(openPut(calls[3]!).value).toBe("same value");
  });

  it("stores in an environment's secrets", async () => {
    const calls = stubGitHub();

    await githubActions({
      repo: "acme/app",
      environment: "prod/eu",
    }).set!("release-keystore", "{}", { cwd: directory });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://api.github.com/repos/acme/app/environments/prod%2Feu/secrets/public-key",
      "https://api.github.com/repos/acme/app/environments/prod%2Feu/secrets/HOT_UPDATER_RELEASE_KEYSTORE",
    ]);
    expect(openPut(calls[1]!).value).toBe("{}");
  });

  it("explains a missing environment", async () => {
    stubGitHub({ keyStatus: 404 });

    await expect(
      githubActions({ repo: "acme/app", environment: "production" }).set!(
        "asc-api-key",
        "{}",
        { cwd: directory },
      ),
    ).rejects.toThrow(
      "Could not read the secrets public key of acme/app, environment production: the repository or its environment production does not exist, or the token can't see it. Create the environment in the repository's settings first (Not Found).",
    );
  });

  it("names the permission GitHub accepts when the token may not write", async () => {
    stubGitHub({
      putStatus: 403,
      headers: { "x-accepted-github-permissions": "secrets=write" },
    });

    await expect(
      githubActions({ repo: "acme/app" }).set!("asc-api-key", "{}", {
        cwd: directory,
      }),
    ).rejects.toThrow(
      "Could not store HOT_UPDATER_ASC_API_KEY in acme/app: the token may not write its secrets; GitHub accepts secrets=write (Resource not accessible by integration).",
    );
  });

  it("masks the token and the value", async () => {
    stubGitHub();
    const value = "spec-github-secret-value";

    await githubActions({ repo: "acme/app" }).set!("TOKEN_B", value, {
      cwd: directory,
    });

    expect(maskSecretValues(`${USER_TOKEN} ${value}`)).toBe(
      "******** ********",
    );
  });

  it.each([
    ["GITHUB_SHA_OVERRIDE", "start with GITHUB_"],
    ["NODE_OPTIONS", "changes how a process loads code"],
  ])("refuses %s", async (name, reason) => {
    const calls = stubGitHub();

    await expect(
      githubActions({ repo: "acme/app" }).set!(name, "x", {
        cwd: directory,
      }),
    ).rejects.toThrow(reason);
    expect(calls).toEqual([]);
  });

  it("refuses a value over GitHub's 48 KB", async () => {
    const calls = stubGitHub();

    await expect(
      githubActions({ repo: "acme/app" }).set!(
        "big",
        "x".repeat(48 * 1024 + 1),
        { cwd: directory },
      ),
    ).rejects.toThrow("GitHub stores secrets up to 48 KB");
    expect(calls).toEqual([]);
  });
});

describe("githubActions token", () => {
  it("uses the token option before anything else", async () => {
    vi.stubEnv("GH_TOKEN", "ghp_specEnvironmentToken");
    const calls = stubGitHub();

    await githubActions({ repo: "acme/app", token: PAT }).set!("a", "v", {
      cwd: directory,
    });

    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: `Bearer ${PAT}`,
    });
    expect(ghCalls()).toBe(0);
  });

  it("uses GH_TOKEN, then GITHUB_TOKEN, before gh auth token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_specGithubToken");
    const calls = stubGitHub();
    const secrets = githubActions({ repo: "acme/app" });

    await secrets.set!("a", "v", { cwd: directory });
    vi.stubEnv("GH_TOKEN", "ghp_specGhToken");
    await secrets.set!("a", "v", { cwd: directory });

    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer ghp_specGithubToken",
    });
    expect(calls[2]!.init.headers).toMatchObject({
      Authorization: "Bearer ghp_specGhToken",
    });
    expect(ghCalls()).toBe(0);
  });

  it("reads the token from .env.hotupdater", async () => {
    await fs.writeFile(
      path.join(directory, ".env.hotupdater"),
      "GH_TOKEN=ghp_specFileToken\n",
    );
    const calls = stubGitHub();

    await githubActions({ repo: "acme/app" }).set!("a", "v", {
      cwd: directory,
    });

    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer ghp_specFileToken",
    });
  });

  it("skips a workflow token in the environment for gh auth token", async () => {
    vi.stubEnv("GITHUB_TOKEN", WORKFLOW_TOKEN);
    const calls = stubGitHub();

    await githubActions({ repo: "acme/app" }).set!("a", "v", {
      cwd: directory,
    });

    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: `Bearer ${USER_TOKEN}`,
    });
  });

  it("refuses a workflow's GITHUB_TOKEN in GitHub Actions", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_TOKEN", WORKFLOW_TOKEN);
    const calls = stubGitHub();

    await expect(
      githubActions({ repo: "acme/app" }).set!("a", "v", {
        cwd: directory,
      }),
    ).rejects.toThrow(
      "A workflow's GITHUB_TOKEN can't write secrets: GitHub has no secrets permission for it.",
    );
    expect(calls).toEqual([]);
    expect(ghCalls()).toBe(0);
  });

  it("refuses in CI without a token, and never runs gh there", async () => {
    vi.stubEnv("CI", "true");
    const calls = stubGitHub();

    await expect(
      githubActions({ repo: "acme/app" }).set!("a", "v", {
        cwd: directory,
      }),
    ).rejects.toThrow(
      "githubActions() has no token to write secrets with in CI.",
    );
    expect(calls).toEqual([]);
    expect(ghCalls()).toBe(0);
  });

  it("writes in CI with a user token", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GH_TOKEN", PAT);
    vi.stubEnv("GITHUB_TOKEN", WORKFLOW_TOKEN);
    const calls = stubGitHub();

    await githubActions({ repo: "acme/app" }).set!("a", "v", {
      cwd: directory,
    });

    expect(calls[1]!.init.headers).toMatchObject({
      Authorization: `Bearer ${PAT}`,
    });
  });

  it("asks for gh auth login without any token", async () => {
    execaMock.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" });
    stubGitHub();

    await expect(
      githubActions({ repo: "acme/app" }).set!("a", "v", {
        cwd: directory,
      }),
    ).rejects.toThrow("sign in with `gh auth login`");
  });
});

describe("githubActions repository", () => {
  it.each([
    "https://github.com/acme/app",
    "https://x-access-token:secret@github.com/acme/app.git",
    "git@github.com:acme/app.git",
    "ssh://git@github.com/acme/app.git",
  ])("reads acme/app from the origin %s", async (remote) => {
    gitRemote(remote);
    const calls = stubGitHub();
    const secrets = githubActions({ token: PAT });

    await secrets.set!("a", "v", { cwd: directory });

    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/acme/app/actions/secrets/public-key",
    );
    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["remote", "get-url", "origin"],
      expect.objectContaining({ cwd: directory }),
    );
    expect(secrets.describe!("a")).toContain("of acme/app");
  });

  it.each([
    ["a GitLab origin", "https://user:hunter22@gitlab.com/acme/app.git"],
    ["no origin", undefined],
  ])("asks for repo with %s, never printing the remote", async (_, remote) => {
    gitRemote(remote);
    stubGitHub();

    const error = await githubActions({ token: PAT }).set!("a", "v", {
      cwd: directory,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'githubActions() found no GitHub repository in the project\'s origin remote. Pass the repository as `repo: "owner/name"`.',
    );
  });

  it("refuses a repo that is not owner/name", () => {
    expect(() => githubActions({ repo: "https://github.com/a/b" })).toThrow(
      'githubActions() takes the repository as "owner/name"',
    );
  });
});

describe("githubActions get", () => {
  it("reads this machine's key store outside a workflow run, never the environment", async () => {
    vi.stubEnv("HOT_UPDATER_ASC_API_KEY", '{"keyId":"env"}');
    await writeLocalKey("asc-api-key", '{"keyId":"local"}', directory);

    await expect(
      githubActions().get(["asc-api-key", "OTHER"], { cwd: directory }),
    ).resolves.toEqual({ "asc-api-key": '{"keyId":"local"}', OTHER: undefined });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("reads the workflow's env inside GitHub Actions", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("HOT_UPDATER_ASC_API_KEY", '{"keyId":"ci"}');
    await writeLocalKey("OTHER", "machine", directory);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubActions().get(["asc-api-key", "OTHER"], { cwd: directory }),
    ).resolves.toEqual({ "asc-api-key": '{"keyId":"ci"}', OTHER: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("githubActions describe", () => {
  it("names the secret, the repository, the environment, the workflow env, and the copy", () => {
    vi.spyOn(process, "cwd").mockReturnValue(directory);
    const copy = getLocalKeyFile("asc-api-key", directory);
    expect(
      githubActions({ repo: "acme/app", environment: "production" }).describe!(
        "asc-api-key",
      ),
    ).toBe(
      `GitHub Actions secret HOT_UPDATER_ASC_API_KEY of acme/app, environment production, which a workflow reads as env HOT_UPDATER_ASC_API_KEY, with a copy in ${copy} on this machine`,
    );
    expect(githubActions().describe!("asc-api-key")).toBe(
      `GitHub Actions secret HOT_UPDATER_ASC_API_KEY of the origin repository, which a workflow reads as env HOT_UPDATER_ASC_API_KEY, with a copy in ${copy} on this machine`,
    );
  });
});
