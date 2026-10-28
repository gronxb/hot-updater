import crypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IssuePlayServiceAccountRequest } from "../playServiceAccount";
import { createGoogleKeyIssuer, parseDeveloperId } from "./googleKeyIssuer";
import { PlayServiceAccountError } from "./types";

const realFetch = globalThis.fetch;

const CLOUD = "https://www.googleapis.com/auth/cloud-platform";
const PUBLISHER = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const IAM = "https://iam.googleapis.com/v1";
const EMAIL = "hot-updater-play@my-app.iam.gserviceaccount.com";
const USER = `${API}/developers/1234/users/${encodeURIComponent(EMAIL)}`;
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

/** The routes of a Google that has the app and one project, my-app. */
const defaultRoutes = (): Record<string, Handler> => ({
  "POST https://oauth2.googleapis.com/token": () => ({
    access_token: "ya29.token",
    scope: `${CLOUD} ${PUBLISHER}`,
    expires_in: 3599,
  }),
  "POST https://oauth2.googleapis.com/revoke": () => ({}),
  [`GET ${API}/developers/1234/users?pageSize=1`]: () => ({ users: [] }),
  [`POST ${API}/applications/com.example.app/edits`]: () => ({ id: "e1" }),
  [`DELETE ${API}/applications/com.example.app/edits/e1`]: () => ({}),
  "GET https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state%3AACTIVE":
    () => ({
      projects: [
        {
          name: "projects/42",
          projectId: "my-app",
          displayName: "My App",
        },
      ],
    }),
  "POST https://serviceusage.googleapis.com/v1/projects/my-app/services:batchEnable":
    () => ({ name: "operations/acf.1", done: false }),
  "GET https://serviceusage.googleapis.com/v1/operations/acf.1": () => ({
    name: "operations/acf.1",
    done: true,
  }),
  [`POST ${IAM}/projects/my-app/serviceAccounts`]: () => ({ email: EMAIL }),
  [`POST ${API}/developers/1234/users`]: () => ({ email: EMAIL }),
  [`POST ${USER}/grants`]: () => ({}),
  [`POST ${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`]: () => ({
    name: KEY_NAME,
    privateKeyData: Buffer.from(KEY_FILE).toString("base64"),
  }),
  [`DELETE ${IAM}/${KEY_NAME}`]: () => ({}),
});

let routes: Record<string, Handler>;
let calls: Call[];

const fetch = vi.fn(
  async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.url}`];
    if (!handler) return googleError(404, "NOT_FOUND", `No route ${call.url}`);
    const answer = handler(call);
    return answer instanceof Response ? answer : json(200, answer);
  },
) as unknown as typeof globalThis.fetch;

/** The browser: Google sends it back to the loopback with `query`. */
let browser: (url: URL) => Record<string, string>;
let authorizationUrl: URL | undefined;

const request = (
  overrides: Partial<IssuePlayServiceAccountRequest> = {},
): IssuePlayServiceAccountRequest => ({
  packageName: "com.example.app",
  oauthClient: {
    clientId: "client.apps.googleusercontent.com",
    clientSecret: "GOCSPX-s",
  },
  onSignInUrl: async (url) => {
    authorizationUrl = new URL(url);
    const redirect = new URL(
      authorizationUrl.searchParams.get("redirect_uri")!,
    );
    redirect.search = new URLSearchParams(browser(authorizationUrl)).toString();
    await realFetch(redirect);
  },
  askDeveloperId: async () => "1234",
  chooseProject: async () => "my-app",
  ...overrides,
});

const issue = (overrides?: Partial<IssuePlayServiceAccountRequest>) =>
  createGoogleKeyIssuer({ fetch, sleep: async () => {} })(request(overrides));

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

const mutations = () =>
  calls.filter(
    (call) =>
      call.method !== "GET" &&
      !call.url.startsWith("https://oauth2.googleapis.com/") &&
      !call.url.includes("/edits"),
  );

beforeEach(() => {
  routes = defaultRoutes();
  calls = [];
  authorizationUrl = undefined;
  browser = (url) => ({
    code: "4/auth-code",
    state: url.searchParams.get("state")!,
  });
});

describe("createGoogleKeyIssuer", () => {
  it("signs in with PKCE on a loopback redirect, then creates the service account, its Play access, and its key, in that order", async () => {
    const issued = await issue();

    // The browser opens Google's consent screen, with PKCE (S256).
    expect(authorizationUrl!.origin + authorizationUrl!.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = authorizationUrl!.searchParams;
    expect(params.get("client_id")).toBe("client.apps.googleusercontent.com");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")!.split(" ").sort()).toEqual(
      [PUBLISHER, CLOUD].sort(),
    );
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // The code is exchanged with the verifier the challenge was made from.
    const [exchange] = called("POST", "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(exchange!.body);
    expect(Object.fromEntries(form)).toEqual({
      code: "4/auth-code",
      client_id: "client.apps.googleusercontent.com",
      client_secret: "GOCSPX-s",
      redirect_uri: params.get("redirect_uri"),
      grant_type: "authorization_code",
      code_verifier: expect.any(String),
    });
    expect(
      crypto
        .createHash("sha256")
        .update(form.get("code_verifier")!)
        .digest("base64url"),
    ).toBe(params.get("code_challenge"));

    expect(
      calls
        .filter(
          (call) => !call.url.startsWith("https://oauth2.googleapis.com/"),
        )
        .map((call) => `${call.method} ${call.url}`),
    ).toEqual([
      `GET ${API}/developers/1234/users?pageSize=1`,
      `POST ${API}/applications/com.example.app/edits`,
      `DELETE ${API}/applications/com.example.app/edits/e1`,
      "GET https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state%3AACTIVE",
      "POST https://serviceusage.googleapis.com/v1/projects/my-app/services:batchEnable",
      "GET https://serviceusage.googleapis.com/v1/operations/acf.1",
      `POST ${IAM}/projects/my-app/serviceAccounts`,
      `POST ${API}/developers/1234/users`,
      `POST ${USER}/grants`,
      `POST ${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`,
    ]);
    // Only Google's sign-in and the four APIs are reached.
    expect(new Set(calls.map((call) => new URL(call.url).host))).toEqual(
      new Set([
        "oauth2.googleapis.com",
        "androidpublisher.googleapis.com",
        "cloudresourcemanager.googleapis.com",
        "serviceusage.googleapis.com",
        "iam.googleapis.com",
      ]),
    );
    for (const call of calls.filter(
      (c) => !c.url.startsWith("https://oauth2."),
    )) {
      expect(call.headers.authorization).toBe("Bearer ya29.token");
    }
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
    expect(body("POST", `${API}/developers/1234/users`)).toEqual({
      name: `developers/1234/users/${EMAIL}`,
      email: EMAIL,
    });
    expect(body("POST", `${USER}/grants`)).toEqual({
      name: `developers/1234/users/${EMAIL}/grants/com.example.app`,
      packageName: "com.example.app",
      appLevelPermissions: [
        "CAN_VIEW_NON_FINANCIAL_DATA",
        "CAN_MANAGE_TRACK_APKS",
      ],
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
      developerId: "1234",
      keyId: "abc123",
    });
    // The sign-in lasts until dispose, so the key can still be deleted.
    expect(called("POST", "https://oauth2.googleapis.com/revoke")).toHaveLength(
      0,
    );
    await expect(issued.revoke()).resolves.toBe(true);
    expect(called("DELETE", `${IAM}/${KEY_NAME}`)).toHaveLength(1);
    await issued.dispose();
    const [revoke] = called("POST", "https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(revoke!.body).get("token")).toBe("ya29.token");
  });

  it("refuses without an OAuth client, before any request", async () => {
    const error = await issueError({ oauthClient: { clientId: "" } });

    expect(error.code).toBe("sign-in-not-configured");
    expect(error.message).toContain("HOT_UPDATER_GOOGLE_OAUTH_CLIENT_ID");
    expect(calls).toEqual([]);
  });

  it("names a cancelled consent screen", async () => {
    browser = (url) => ({
      error: "access_denied",
      state: url.searchParams.get("state")!,
    });

    const error = await issueError();

    expect(error.code).toBe("sign-in-cancelled");
    expect(calls).toEqual([]);
  });

  it("ignores an answer to another sign-in", async () => {
    let first = true;
    browser = (url) => {
      if (first) {
        first = false;
        return { code: "stolen", state: "other" };
      }
      return { code: "4/auth-code", state: url.searchParams.get("state")! };
    };
    const onSignInUrl = request().onSignInUrl;

    await issue({
      onSignInUrl: async (url) => {
        await onSignInUrl(url);
        await onSignInUrl(url);
      },
    });

    const [exchange] = called("POST", "https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(exchange!.body).get("code")).toBe("4/auth-code");
  });

  it("names a scope the account unticked, and ends the sign-in", async () => {
    routes["POST https://oauth2.googleapis.com/token"] = () => ({
      access_token: "ya29.token",
      scope: CLOUD,
    });

    const error = await issueError();

    expect(error.code).toBe("scope-not-granted");
    expect(error.message).toContain("managing Google Play");
    expect(called("POST", "https://oauth2.googleapis.com/revoke")).toHaveLength(
      1,
    );
  });

  it("takes the developer account ID from a pasted Play Console address", async () => {
    await issue({
      askDeveloperId: async () =>
        "https://play.google.com/console/u/0/developers/1234/app-list",
    });

    expect(
      called("GET", `${API}/developers/1234/users?pageSize=1`),
    ).toHaveLength(1);
  });

  it("names a developer account ID that is none, before any change", async () => {
    const error = await issueError({ askDeveloperId: async () => "my team" });

    expect(error.code).toBe("developer-not-found");
    expect(mutations()).toEqual([]);
  });

  it("names a developer account Play Console does not have, before any change", async () => {
    routes[`GET ${API}/developers/1234/users?pageSize=1`] = () =>
      googleError(404, "NOT_FOUND", "Developer not found.");

    const error = await issueError();

    expect(error.code).toBe("developer-not-found");
    expect(mutations()).toEqual([]);
    expect(called("POST", "https://oauth2.googleapis.com/revoke")).toHaveLength(
      1,
    );
  });

  it("names an account that is no Play Console admin, before any change", async () => {
    routes[`GET ${API}/developers/1234/users?pageSize=1`] = () =>
      googleError(
        403,
        "PERMISSION_DENIED",
        "The caller does not have permission",
      );

    const error = await issueError();

    expect(error.code).toBe("not-play-admin");
    expect(mutations()).toEqual([]);
  });

  it("names the Play Developer API disabled in the OAuth client's project, not a missing admin role, before any change", async () => {
    routes[`GET ${API}/developers/1234/users?pageSize=1`] = () =>
      serviceDisabled("projects/999");

    const error = await issueError();

    expect(error.code).toBe("api-not-enabled");
    expect(error.message).toContain("OAuth client");
    expect(mutations()).toEqual([]);
  });

  it("keeps Google's words in a Play Console refusal", async () => {
    routes[`GET ${API}/developers/1234/users?pageSize=1`] = () =>
      googleError(403, "PERMISSION_DENIED", "Something else went wrong.");

    const error = await issueError();

    expect(error.code).toBe("not-play-admin");
    expect(error.message).toContain("\nGoogle: Something else went wrong.");
  });

  it("names a Play Console refusal to add the service account as a missing admin role", async () => {
    routes[`POST ${USER}/grants`] = () =>
      googleError(
        403,
        "PERMISSION_DENIED",
        "The caller does not have permission",
      );

    const error = await issueError();

    expect(error.code).toBe("not-play-admin");
    expect(
      called("POST", `${IAM}/projects/my-app/serviceAccounts/${EMAIL}/keys`),
    ).toEqual([]);
  });

  it("names an app Google Play does not have yet, with the manual first upload, before any change", async () => {
    routes[`POST ${API}/applications/com.example.app/edits`] = () =>
      googleError(404, "NOT_FOUND", "Package not found: com.example.app.");

    const error = await issueError();

    expect(error.code).toBe("app-not-found");
    expect(error.message).toContain("upload one .aab by hand");
    expect(mutations()).toEqual([]);
  });

  it("creates a project when the account has none, and waits for it", async () => {
    const chooseProject = vi.fn(async () => "never");
    routes[
      "GET https://cloudresourcemanager.googleapis.com/v3/projects:search?query=state%3AACTIVE"
    ] = () => ({});
    let projectId = "";
    routes["POST https://cloudresourcemanager.googleapis.com/v3/projects"] = (
      call,
    ) => {
      projectId = (JSON.parse(call.body!) as { projectId: string }).projectId;
      return { name: "operations/cp.1", done: false };
    };
    routes[
      "GET https://cloudresourcemanager.googleapis.com/v3/operations/cp.1"
    ] = () => ({
      name: "operations/cp.1",
      done: true,
      response: { name: "projects/77", projectId },
    });
    routes = new Proxy(routes, {
      get: (target, key: string) =>
        target[key] ??
        target[key.replaceAll(/hot-updater-play-[0-9a-f]{6}/gu, "my-app")],
    });

    const issued = await issue({ chooseProject });

    expect(chooseProject).not.toHaveBeenCalled();
    expect(projectId).toMatch(/^hot-updater-play-[0-9a-f]{6}$/);
    expect(issued.projectId).toBe(projectId);
    expect(
      called(
        "GET",
        "https://cloudresourcemanager.googleapis.com/v3/operations/cp.1",
      ),
    ).toHaveLength(1);
  });

  it("names a project quota that is used up", async () => {
    routes["POST https://cloudresourcemanager.googleapis.com/v3/projects"] =
      () =>
        googleError(
          429,
          "RESOURCE_EXHAUSTED",
          "Project creation quota exceeded.",
        );

    const error = await issueError({ chooseProject: async () => undefined });

    expect(error.code).toBe("project-quota");
  });

  it("names a quota failure the project's operation reports", async () => {
    routes["POST https://cloudresourcemanager.googleapis.com/v3/projects"] =
      () => ({
        name: "operations/cp.1",
        done: true,
        error: { code: 8, message: "You have exceeded your project quota." },
      });

    const error = await issueError({ chooseProject: async () => undefined });

    expect(error.code).toBe("project-quota");
  });

  it("names an account that may not create projects", async () => {
    routes["POST https://cloudresourcemanager.googleapis.com/v3/projects"] =
      () =>
        googleError(
          403,
          "PERMISSION_DENIED",
          "Permission 'resourcemanager.projects.create' denied.",
        );

    const error = await issueError({ chooseProject: async () => undefined });

    expect(error.code).toBe("project-create-denied");
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

  it("does not wait for an API disabled in the OAuth client's own project", async () => {
    routes[`POST ${IAM}/projects/my-app/serviceAccounts`] = () =>
      serviceDisabled("projects/999");

    const error = await issueError();

    expect(error.code).toBe("api-not-enabled");
    expect(error.message).toContain("OAuth client");
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

  it("reuses what an earlier run created, adding the release permissions to the app's grant", async () => {
    routes[`POST ${IAM}/projects/my-app/serviceAccounts`] = () =>
      googleError(409, "ALREADY_EXISTS", "Service account already exists.");
    routes[`POST ${API}/developers/1234/users`] = () =>
      googleError(409, "ALREADY_EXISTS", "User already exists.");
    routes[`POST ${USER}/grants`] = () =>
      googleError(409, "ALREADY_EXISTS", "Grant already exists.");
    routes[`GET ${API}/developers/1234/users?pageSize=100`] = () => ({
      users: [
        { email: "someone@example.com" },
        {
          email: EMAIL,
          grants: [
            {
              packageName: "com.example.app",
              appLevelPermissions: [
                "CAN_REPLY_TO_REVIEWS",
                "CAN_MANAGE_TRACK_APKS",
              ],
            },
          ],
        },
      ],
    });
    const grant = `PATCH ${USER}/grants/com.example.app?updateMask=appLevelPermissions`;
    routes[grant] = () => ({});

    const issued = await issue();

    expect(issued.email).toBe(EMAIL);
    expect(
      JSON.parse(called("PATCH", grant.slice("PATCH ".length))[0]!.body!),
    ).toEqual({
      appLevelPermissions: [
        "CAN_REPLY_TO_REVIEWS",
        "CAN_MANAGE_TRACK_APKS",
        "CAN_VIEW_NON_FINANCIAL_DATA",
      ],
    });
  });

  it("leaves a grant that has the release permissions as it is", async () => {
    routes[`POST ${USER}/grants`] = () =>
      googleError(409, "ALREADY_EXISTS", "Grant already exists.");
    routes[`GET ${API}/developers/1234/users?pageSize=100`] = () => ({
      users: [
        {
          email: EMAIL,
          grants: [
            {
              packageName: "com.example.app",
              appLevelPermissions: [
                "CAN_VIEW_NON_FINANCIAL_DATA",
                "CAN_MANAGE_TRACK_APKS",
              ],
            },
          ],
        },
      ],
    });

    await issue();

    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});

describe("parseDeveloperId", () => {
  it.each([
    ["1234", "1234"],
    [" 1234 ", "1234"],
    ["https://play.google.com/console/u/0/developers/1234/app-list", "1234"],
    ["https://play.google.com/console/developers/1234", "1234"],
    ["my team", undefined],
    ["https://play.google.com/console/developers/12a4", undefined],
  ])("%s → %s", (input, id) => {
    expect(parseDeveloperId(input)).toBe(id);
  });
});
