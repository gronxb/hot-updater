import crypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IssuePlayServiceAccountRequest } from "../playServiceAccount";
import { createGoogleKeyIssuer, type RunCommand } from "./googleKeyIssuer";
import { PlayServiceAccountError } from "./types";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const IAM = "https://iam.googleapis.com/v1";
const TOKEN = "https://oauth2.googleapis.com/token";
const EDITS = `${API}/applications/com.example.app/edits`;
const EMAIL = "hot-updater-play@my-app.iam.gserviceaccount.com";
const INVITE_URL =
  "https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=hot-updater-play%40my-app.iam.gserviceaccount.com";
const KEY_NAME = `projects/my-app/serviceAccounts/${EMAIL}/keys/abc123`;
const PRIVATE_KEY = crypto
  .generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "my-app",
  client_email: EMAIL,
  private_key: PRIVATE_KEY,
});

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

type Handler = (call: Call) => Response | object;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const googleError = (
  status: number,
  apiStatus: string,
  message: string,
  details: unknown[] = [],
) =>
  json(status, {
    error: { code: status, status: apiStatus, message, details },
  });

const serviceDisabled = (consumer = "projects/42") =>
  googleError(
    403,
    "PERMISSION_DENIED",
    "Identity and Access Management (IAM) API has not been used in project 42 before or it is disabled.",
    [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        metadata: { consumer },
      },
    ],
  );

const notInvited = () =>
  googleError(403, "PERMISSION_DENIED", "The caller does not have permission");

const SEARCH =
  "https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state%3AACTIVE";
const CREATE = "https://cloudresourcemanager.googleapis.com/v3/projects";
/** Service Usage's read of the Play Developer API in `projectId`. */
const playApi = (projectId: string) =>
  `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/androidpublisher.googleapis.com`;

/**
 * The routes of a Google that has one project with the Play Developer API,
 * my-app, as an earlier run leaves it, and a Play Console that already
 * invited the service account.
 */
const defaultRoutes = (): Record<string, Handler> => ({
  [`GET ${SEARCH}`]: () => ({
    projects: [
      {
        name: "projects/42",
        projectId: "my-app",
        displayName: "Hot Updater Play",
      },
    ],
  }),
  [`GET ${playApi("my-app")}`]: () => ({ state: "ENABLED" }),
  "POST https://serviceusage.googleapis.com/v1/projects/my-app/services:batchEnable":
    () => ({ name: "operations/acf.1", done: false }),
  "GET https://serviceusage.googleapis.com/v1/operations/acf.1": () => ({
    name: "operations/acf.1",
    done: true,
  }),
  [`POST ${IAM}/projects/my-app/serviceAccounts`]: () => ({ email: EMAIL }),
  [`POST ${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`]: () => ({
    name: KEY_NAME,
    privateKeyData: Buffer.from(KEY_FILE).toString("base64"),
  }),
  [`DELETE ${IAM}/${KEY_NAME}`]: () => ({}),
  [`POST ${TOKEN}`]: () => ({ access_token: "ya29.key", expires_in: 3599 }),
  [`POST ${EDITS}`]: () => ({ id: "e1" }),
  [`DELETE ${EDITS}/e1`]: () => ({}),
});

let routes: Record<string, Handler>;
/** Every request, and `invite` when the issuer hands out the invite. */
let calls: Call[];
let events: string[];

/**
 * The account's projects, each with the Play Developer API when `enabled`;
 * the API's state of one Service Usage can't read is a 403.
 */
const accountProjects = (
  projects: {
    projectId: string;
    displayName?: string;
    enabled?: boolean | "unreadable";
  }[],
) => {
  routes[`GET ${SEARCH}`] = () => ({
    projects: projects.map(({ projectId, displayName }, index) => ({
      name: `projects/${43 + index}`,
      projectId,
      ...(displayName ? { displayName } : {}),
    })),
  });
  for (const { projectId, enabled = false } of projects) {
    routes[`GET ${playApi(projectId)}`] = () =>
      enabled === "unreadable"
        ? googleError(403, "PERMISSION_DENIED", "Permission denied.")
        : { state: enabled ? "ENABLED" : "DISABLED" };
  }
};

/** The account has projects, none of them with the Play Developer API. */
const otherProjectsOnly = () =>
  accountProjects([{ projectId: "other", displayName: "Other" }]);

/** Google creates the project it is asked for, which then works as my-app. */
const createsProjects = () => {
  let created: { projectId: string; displayName: string } | undefined;
  routes[`POST ${CREATE}`] = (call) => {
    created = JSON.parse(call.body!) as typeof created;
    return { name: "operations/cp.1", done: false };
  };
  routes["GET https://cloudresourcemanager.googleapis.com/v3/operations/cp.1"] =
    () => ({
      name: "operations/cp.1",
      done: true,
      response: { name: "projects/77", projectId: created!.projectId },
    });
  routes = new Proxy(routes, {
    get: (target, key: string) =>
      target[key] ??
      target[key.replaceAll(/hot-updater-play-[0-9a-f]{6}/gu, "my-app")],
  });
  return () => created;
};

const fetch = vi.fn(
  async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    events.push(`${call.method} ${call.url}`);
    const handler = routes[`${call.method} ${call.url}`];
    if (!handler) return googleError(404, "NOT_FOUND", `No route ${call.url}`);
    const answer = handler(call);
    return answer instanceof Response ? answer : json(200, answer);
  },
) as unknown as typeof globalThis.fetch;

/** The gcloud CLI on this machine, and the account it is signed in to. */
let gcloud: {
  installed: boolean;
  account: string | undefined;
  /** The account `gcloud auth login` signs in to. */
  login: string | undefined;
  /** `gcloud auth login` fails, as a cancelled sign-in does. */
  loginFails?: boolean;
};
let commands: string[];

const run: RunCommand = async (file, args, options) => {
  const command = [file, ...args].join(" ");
  commands.push(options?.interactive ? `${command} (interactive)` : command);
  if (!gcloud.installed) {
    throw Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" });
  }
  if (args[0] === "--version") return "Google Cloud SDK 500.0.0";
  if (args.join(" ").startsWith("auth list")) return gcloud.account ?? "";
  if (args.join(" ") === "auth login") {
    if (gcloud.loginFails) throw new Error("gcloud auth login: cancelled");
    gcloud.account = gcloud.login;
    return "";
  }
  if (args.join(" ") === "auth print-access-token") return "ya29.token\n";
  throw new Error(`Unexpected command: ${command}`);
};

const sleep = vi.fn(async (_ms: number) => {});
const onStep = vi.fn((_message: string) => {});
const onInvite = vi.fn((_url: string, _email: string) => {
  events.push("invite");
});
const askPackageName = vi.fn(async () => {
  commands.push("ask the package name");
  return "com.example.app";
});

const request = (
  overrides: Partial<IssuePlayServiceAccountRequest> = {},
): IssuePlayServiceAccountRequest => ({
  askPackageName,
  onInvite,
  chooseProject: async () => "my-app",
  onStep,
  ...overrides,
});

const issue = (overrides?: Partial<IssuePlayServiceAccountRequest>) =>
  createGoogleKeyIssuer({ fetch, sleep, run })(request(overrides));

const issueError = async (
  overrides?: Partial<IssuePlayServiceAccountRequest>,
): Promise<PlayServiceAccountError> => {
  const error = await issue(overrides).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PlayServiceAccountError);
  return error as PlayServiceAccountError;
};

const called = (method: string, url: string) =>
  calls.filter((call) => call.method === method && call.url === url);

beforeEach(() => {
  vi.clearAllMocks();
  routes = defaultRoutes();
  calls = [];
  events = [];
  commands = [];
  gcloud = {
    installed: true,
    account: "dev@example.com",
    login: "dev@example.com",
  };
});

describe("createGoogleKeyIssuer", () => {
  it("signs in with gcloud, creates the service account and its key, opens the invite, and waits until the key reaches the app", async () => {
    const issued = await issue();

    expect(commands).toEqual([
      "gcloud --version",
      "ask the package name",
      "gcloud auth list --filter=status:ACTIVE --format=value(account)",
      "gcloud auth print-access-token",
    ]);
    expect(onStep).toHaveBeenCalledWith(
      "Signed in to gcloud as dev@example.com",
    );
    expect(events).toEqual([
      `GET ${SEARCH}`,
      `GET ${playApi("my-app")}`,
      "POST https://serviceusage.googleapis.com/v1/projects/my-app/services:batchEnable",
      "GET https://serviceusage.googleapis.com/v1/operations/acf.1",
      `POST ${IAM}/projects/my-app/serviceAccounts`,
      `POST ${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`,
      "invite",
      `POST ${TOKEN}`,
      `POST ${EDITS}`,
      `DELETE ${EDITS}/e1`,
    ]);
    // Play Console's invite names the service account, URL-encoded, and no
    // developer account: `_` is the one the browser is signed in to.
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(onInvite).toHaveBeenCalledWith(INVITE_URL, EMAIL);

    // Google Cloud is reached with gcloud's token, Google Play with the key's.
    for (const call of calls.filter((c) =>
      /cloudresourcemanager|serviceusage|iam\.googleapis/u.test(c.url),
    )) {
      expect(call.headers.authorization).toBe("Bearer ya29.token");
    }
    for (const call of called("POST", EDITS)) {
      expect(call.headers.Authorization).toBe("Bearer ya29.key");
    }
    const [exchange] = called("POST", TOKEN);
    const form = new URLSearchParams(exchange!.body);
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const [, claims] = form.get("assertion")!.split(".");
    expect(
      JSON.parse(Buffer.from(claims!, "base64url").toString()),
    ).toMatchObject({
      iss: EMAIL,
      scope: "https://www.googleapis.com/auth/androidpublisher",
    });

    const body = (method: string, url: string) =>
      JSON.parse(called(method, url)[0]!.body!) as unknown;
    expect(
      body(
        "POST",
        "https://serviceusage.googleapis.com/v1/projects/my-app/services:batchEnable",
      ),
    ).toEqual({
      serviceIds: ["iam.googleapis.com", "androidpublisher.googleapis.com"],
    });
    expect(
      body("POST", `${IAM}/projects/my-app/serviceAccounts`),
    ).toMatchObject({
      accountId: "hot-updater-play",
    });
    expect(
      body("POST", `${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`),
    ).toEqual({
      privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
      keyAlgorithm: "KEY_ALG_RSA_2048",
    });

    expect(issued).toMatchObject({
      json: KEY_FILE,
      email: EMAIL,
      projectId: "my-app",
      keyId: "abc123",
    });
    expect(issued).not.toHaveProperty("developerId");
    expect(called("DELETE", `${IAM}/${KEY_NAME}`)).toHaveLength(0);
    // gcloud keeps its sign-in: dispose reaches nothing.
    const before = calls.length;
    await issued.dispose();
    expect(calls).toHaveLength(before);
    await expect(issued.revoke()).resolves.toBe(true);
    expect(called("DELETE", `${IAM}/${KEY_NAME}`)).toHaveLength(1);
  });

  it("stops before any prompt or request when gcloud is not installed, naming where to get it", async () => {
    gcloud.installed = false;

    const error = await issueError();

    expect(error.code).toBe("gcloud-not-installed");
    expect(error.message).toBe(
      [
        "gcloud CLI is not installed.",
        "Install it, then run this again:",
        "https://cloud.google.com/sdk/docs/install",
      ].join("\n"),
    );
    expect(commands).toEqual(["gcloud --version"]);
    expect(askPackageName).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(onInvite).not.toHaveBeenCalled();
  });

  it("runs gcloud auth login on the terminal when no account is active", async () => {
    gcloud.account = undefined;

    await issue();

    expect(commands).toEqual([
      "gcloud --version",
      "ask the package name",
      "gcloud auth list --filter=status:ACTIVE --format=value(account)",
      "gcloud auth login (interactive)",
      "gcloud auth list --filter=status:ACTIVE --format=value(account)",
      "gcloud auth print-access-token",
    ]);
    expect(onStep).toHaveBeenCalledWith(
      "Signed in to gcloud as dev@example.com",
    );
  });

  it("stops before any request when gcloud auth login leaves no active account", async () => {
    gcloud.account = undefined;
    gcloud.login = undefined;

    const error = await issueError();

    expect(error.code).toBe("gcloud-not-signed-in");
    expect(calls).toEqual([]);
  });

  it("names a cancelled gcloud auth login, before any request", async () => {
    gcloud.account = undefined;
    gcloud.loginFails = true;

    const error = await issueError();

    expect(error.code).toBe("gcloud-not-signed-in");
    expect(calls).toEqual([]);
  });

  it("waits while Google takes the new key and Play Console the invite, every 5 seconds", async () => {
    let exchanges = 0;
    routes[`POST ${TOKEN}`] = () =>
      ++exchanges <= 2
        ? json(400, {
            error: "invalid_grant",
            error_description: "Invalid JWT Signature.",
          })
        : { access_token: "ya29.key" };
    let opened = 0;
    routes[`POST ${EDITS}`] = () =>
      ++opened <= 2
        ? notInvited()
        : opened === 3
          ? googleError(404, "NOT_FOUND", "Package not found: com.example.app.")
          : { id: "e1" };

    const issued = await issue();

    expect(issued.email).toBe(EMAIL);
    // Two refused exchanges, then one token for every edit after.
    expect(called("POST", TOKEN)).toHaveLength(3);
    expect(called("POST", EDITS)).toHaveLength(4);
    expect(called("DELETE", `${EDITS}/e1`)).toHaveLength(1);
    expect(sleep.mock.calls.filter(([ms]) => ms === 5_000)).toHaveLength(5);
    expect(called("DELETE", `${IAM}/${KEY_NAME}`)).toHaveLength(0);
  });

  it("deletes the key after about ten minutes without access, and says to invite it and run login again", async () => {
    routes[`POST ${EDITS}`] = notInvited;

    const error = await issueError();

    expect(error.code).toBe("play-access-pending");
    expect(error.message).toBe(
      [
        "The key can't release com.example.app yet.",
        "Invite the service account in Play Console with release access:",
        EMAIL,
        INVITE_URL,
        "A new app needs its first .aab uploaded in Play Console.",
        "Then run: npx hot-updater google-play login",
      ].join("\n"),
    );
    expect(called("POST", EDITS)).toHaveLength(120);
    expect(sleep.mock.calls.filter(([ms]) => ms === 5_000)).toHaveLength(119);
    expect(called("DELETE", `${IAM}/${KEY_NAME}`)).toHaveLength(1);
    // The key is deleted with gcloud's token, not its own.
    expect(
      called("DELETE", `${IAM}/${KEY_NAME}`)[0]!.headers.authorization,
    ).toBe("Bearer ya29.token");
  });

  it("names the key to delete by hand when deleting it fails too", async () => {
    routes[`POST ${EDITS}`] = notInvited;
    routes[`DELETE ${IAM}/${KEY_NAME}`] = () =>
      googleError(503, "UNAVAILABLE", "Try again later.");

    const error = await issueError();

    expect(error.code).toBe("play-access-pending");
    expect(error.message.split("\n").slice(-3)).toEqual([
      "Delete its unused key abc123 in Google Cloud:",
      "https://console.cloud.google.com/iam-admin/serviceaccounts?project=my-app",
      "Then run: npx hot-updater google-play login",
    ]);
  });

  it("deletes the key when Google Play fails otherwise, keeping the failure as the cause", async () => {
    routes[`POST ${EDITS}`] = () =>
      googleError(500, "INTERNAL", "Internal error.");

    const error = await issueError();

    expect(error.code).toBe("play-access-pending");
    expect(String((error.cause as Error).message)).toContain("Internal error.");
    expect(called("POST", EDITS)).toHaveLength(1);
    expect(called("DELETE", `${IAM}/${KEY_NAME}`)).toHaveLength(1);
  });

  it("uses the account's only project with the Play Developer API without asking, and says so", async () => {
    accountProjects([
      { projectId: "web", displayName: "Web" },
      { projectId: "my-app", displayName: "My App", enabled: true },
      { projectId: "locked", enabled: "unreadable" },
    ]);
    const chooseProject = vi.fn(async () => "never");

    const issued = await issue({ chooseProject });

    expect(chooseProject).not.toHaveBeenCalled();
    expect(issued.projectId).toBe("my-app");
    expect(onStep).toHaveBeenCalledWith(
      "Using my-app, the project with the Play Developer API",
    );
    // One list, then one read of each project's API.
    expect(events.slice(0, 4).sort()).toEqual(
      [
        `GET ${SEARCH}`,
        `GET ${playApi("web")}`,
        `GET ${playApi("my-app")}`,
        `GET ${playApi("locked")}`,
      ].sort(),
    );
    expect(called("POST", CREATE)).toEqual([]);
  });

  it("asks among the account's projects when several have the Play Developer API", async () => {
    accountProjects([
      { projectId: "my-app", displayName: "My App", enabled: true },
      { projectId: "shop", enabled: true },
      { projectId: "web" },
    ]);
    const chooseProject = vi.fn(async () => "my-app");

    const issued = await issue({ chooseProject });

    expect(chooseProject).toHaveBeenCalledExactlyOnceWith([
      { projectId: "my-app", displayName: "My App", playApiEnabled: true },
      { projectId: "shop", playApiEnabled: true },
      { projectId: "web", playApiEnabled: false },
    ]);
    expect(issued.projectId).toBe("my-app");
    expect(called("POST", CREATE)).toEqual([]);
  });

  it("asks when no project has the Play Developer API, and creates one when picked", async () => {
    otherProjectsOnly();
    const created = createsProjects();
    const chooseProject = vi.fn(async () => null);

    const issued = await issue({ chooseProject });

    expect(chooseProject).toHaveBeenCalledExactlyOnceWith([
      { projectId: "other", displayName: "Other", playApiEnabled: false },
    ]);
    expect(created()!.projectId).toMatch(/^hot-updater-play-[0-9a-f]{6}$/);
    expect(issued.projectId).toBe(created()!.projectId);
  });

  it("creates a project without asking, or reading any API, for an account without projects", async () => {
    routes[`GET ${SEARCH}`] = () => ({});
    const created = createsProjects();
    const chooseProject = vi.fn(async () => "never");

    const issued = await issue({ chooseProject });

    expect(chooseProject).not.toHaveBeenCalled();
    expect(created()!.projectId).toMatch(/^hot-updater-play-[0-9a-f]{6}$/);
    expect(created()!.displayName).toBe("Hot Updater Play");
    expect(issued.projectId).toBe(created()!.projectId);
    expect(
      calls.filter(({ url }) =>
        url.endsWith("/androidpublisher.googleapis.com"),
      ),
    ).toEqual([]);
    expect(
      called(
        "GET",
        "https://cloudresourcemanager.googleapis.com/v3/operations/cp.1",
      ),
    ).toHaveLength(1);
  });

  it("names a project quota that is used up", async () => {
    otherProjectsOnly();
    routes[`POST ${CREATE}`] = () =>
      googleError(
        429,
        "RESOURCE_EXHAUSTED",
        "Project creation quota exceeded.",
      );

    const error = await issueError({ chooseProject: async () => null });

    expect(error.code).toBe("project-quota");
  });

  it("names a quota failure the project's operation reports", async () => {
    otherProjectsOnly();
    routes[`POST ${CREATE}`] = () => ({
      name: "operations/cp.1",
      done: true,
      error: { code: 8, message: "You have exceeded your project quota." },
    });

    const error = await issueError({ chooseProject: async () => null });

    expect(error.code).toBe("project-quota");
  });

  it("names an account that may not create projects and has none to pick", async () => {
    routes[`GET ${SEARCH}`] = () => ({});
    routes[`POST ${CREATE}`] = () =>
      googleError(
        403,
        "PERMISSION_DENIED",
        "Permission 'resourcemanager.projects.create' denied.",
      );
    const chooseProject = vi.fn(async () => "never");

    const error = await issueError({ chooseProject });

    expect(error.code).toBe("project-create-denied");
    expect(chooseProject).not.toHaveBeenCalled();
  });

  it("waits while Google is still enabling IAM in the project", async () => {
    let attempts = 0;
    routes[`POST ${IAM}/projects/my-app/serviceAccounts`] = () =>
      ++attempts < 3 ? serviceDisabled() : { email: EMAIL };

    await issue();

    expect(attempts).toBe(3);
  });

  it("names an API Google never finished enabling", async () => {
    routes[`POST ${IAM}/projects/my-app/serviceAccounts`] = () =>
      serviceDisabled();

    const error = await issueError();

    expect(error.code).toBe("api-not-enabled");
    expect(error.message).toContain("Wait a few minutes");
    expect(
      called("POST", `${IAM}/projects/my-app/serviceAccounts`),
    ).toHaveLength(12);
  });

  it("does not wait for an API disabled in another project, and names it", async () => {
    routes[`POST ${IAM}/projects/my-app/serviceAccounts`] = () =>
      serviceDisabled("projects/999");

    const error = await issueError();

    expect(error.code).toBe("api-not-enabled");
    expect(error.message).toContain("Enable it in projects/999");
    expect(
      called("POST", `${IAM}/projects/my-app/serviceAccounts`),
    ).toHaveLength(1);
  });

  it("names the organization policy that forbids keys, and what to ask for", async () => {
    routes[`POST ${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`] = () =>
      googleError(
        400,
        "FAILED_PRECONDITION",
        "Key creation is not allowed on this service account.",
        [
          {
            "@type": "type.googleapis.com/google.rpc.PreconditionFailure",
            violations: [
              { type: "constraints/iam.disableServiceAccountKeyCreation" },
            ],
          },
        ],
      );

    const error = await issueError();

    expect(error.code).toBe("key-creation-disabled");
    expect(error.message).toContain("iam.disableServiceAccountKeyCreation");
  });

  it("reuses the service account an earlier run created", async () => {
    routes[`POST ${IAM}/projects/my-app/serviceAccounts`] = () =>
      googleError(409, "ALREADY_EXISTS", "Service account already exists.");

    const issued = await issue();

    expect(issued.email).toBe(EMAIL);
    expect(onInvite).toHaveBeenCalledWith(INVITE_URL, EMAIL);
  });
});
