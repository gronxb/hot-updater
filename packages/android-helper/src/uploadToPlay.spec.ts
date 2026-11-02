import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const { createCredentialResolver, maskSecretValues, registerSecretValue } =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    createCredentialResolver,
    maskSecretValues,
    registerSecretValue,
    p: { log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() } },
  };
});

import {
  createCredentialResolver,
  maskSecretValues,
  p,
} from "@hot-updater/cli-tools";
import type { NativeBuildAndroidScheme } from "@hot-updater/plugin-core";

import {
  checkPlayAccess,
  createServiceAccountAssertion,
  findPlayInternalRelease,
  playConsoleInviteUrl,
  playTestingUrl,
  PlayVersionCodeUsedError,
  readPlayHighestVersionCode,
  readPlayInternalRelease,
  resolvePlayUploadServiceAccount,
  uploadToPlay,
} from "./uploadToPlay";

const API = "https://androidpublisher.googleapis.com";
const APP = `${API}/androidpublisher/v3/applications/com.example.app`;
const EDIT = `${APP}/edits/edit-1`;
const SESSION = `${API}/upload/androidpublisher/v3/applications/com.example.app/edits/edit-1/bundles?uploadType=resumable`;
const LOCATION = `${API}/upload/androidpublisher/v3/applications/com.example.app/edits/edit-1/bundles?uploadType=resumable&upload_id=session-1`;
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN = "ya29.access-token-from-google";

type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

type Reply = {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
};

/**
 * A fetch that records every request and answers from `routes`, keyed by
 * `<METHOD> <url>`; a route with several replies answers them in turn.
 */
const createRecordingFetch = (routes: Record<string, Reply | Reply[]>) => {
  const requests: Recorded[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body;
      requests.push({
        method,
        url,
        headers: { ...(init?.headers as Record<string, string>) },
        body:
          typeof body === "string"
            ? body.startsWith("{")
              ? JSON.parse(body)
              : Object.fromEntries(new URLSearchParams(body))
            : body instanceof Uint8Array
              ? Buffer.from(body).toString()
              : body,
      });
      const route = routes[`${method} ${url}`];
      const reply = Array.isArray(route)
        ? route.length > 1
          ? route.shift()
          : route[0]
        : route;
      if (!reply) {
        return Response.json(
          { error: { message: `No route for ${method} ${url}` } },
          { status: 404 },
        );
      }
      const status = reply.status ?? 200;
      return new Response(
        status === 204 || status === 308 || reply.json === undefined
          ? null
          : JSON.stringify(reply.json),
        { status, headers: reply.headers },
      );
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
};

const successRoutes = (): Record<string, Reply | Reply[]> => ({
  [`POST ${TOKEN_URI}`]: {
    json: { access_token: ACCESS_TOKEN, expires_in: 3599 },
  },
  [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
  [`POST ${SESSION}`]: { headers: { location: LOCATION } },
  [`PUT ${LOCATION}`]: {
    json: { versionCode: 42, sha256: "abc" },
  },
  [`PUT ${EDIT}/tracks/internal`]: { json: { track: "internal" } },
  [`POST ${EDIT}:commit`]: { json: { id: "edit-1" } },
});

const AAB_BYTES = Buffer.from("android app bundle bytes");

let dir: string;
let aabPath: string;
let serviceAccountJson: string;
let publicKey: crypto.KeyObject;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "play-upload-"));
  aabPath = path.join(dir, "app-release.aab");
  await fs.writeFile(aabPath, AAB_BYTES);
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  publicKey = pair.publicKey;
  serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: "example",
    private_key_id: "key-1",
    private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    client_email: "uploader@example.iam.gserviceaccount.com",
    token_uri: TOKEN_URI,
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

const decodeJwt = (jwt: string) => {
  const [header, payload, signature] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
};

const upload = (fetch: typeof globalThis.fetch) =>
  uploadToPlay({
    aabPath,
    packageName: "com.example.app",
    serviceAccount: { json: serviceAccountJson },
    fetch,
    commitRetryDelayMs: 0,
  });

describe("createServiceAccountAssertion", () => {
  it("signs an RS256 JWT for the androidpublisher scope", () => {
    const { private_key } = JSON.parse(serviceAccountJson);
    const assertion = createServiceAccountAssertion({
      clientEmail: "uploader@example.iam.gserviceaccount.com",
      privateKey: crypto.createPrivateKey(private_key),
      tokenUri: TOKEN_URI,
      issuedAtSeconds: 1_700_000_000,
    });

    const { header, payload, signingInput, signature } = decodeJwt(assertion);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({
      iss: "uploader@example.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: TOKEN_URI,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 3600,
    });
    expect(
      crypto.verify("sha256", Buffer.from(signingInput), publicKey, signature),
    ).toBe(true);
  });
});

describe("uploadToPlay", () => {
  it("releases the .aab to the internal track through one edit, in order", async () => {
    const { fetch, requests } = createRecordingFetch(successRoutes());

    await expect(upload(fetch)).resolves.toEqual({
      versionCode: 42,
      status: "completed",
    });

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${TOKEN_URI}`,
      `POST ${APP}/edits`,
      `POST ${SESSION}`,
      `PUT ${LOCATION}`,
      `PUT ${EDIT}/tracks/internal`,
      `POST ${EDIT}:commit`,
    ]);
    const [token, insert, session, chunk, track] = requests;
    expect(token!.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: expect.any(String),
    });
    const assertion = decodeJwt(
      (token!.body as { assertion: string }).assertion,
    );
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(assertion.signingInput),
        publicKey,
        assertion.signature,
      ),
    ).toBe(true);
    expect(insert!.headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(session!.headers).toMatchObject({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(AAB_BYTES.length),
    });
    // The session URL is the upload's authority: no token goes with it.
    expect(chunk).toEqual({
      method: "PUT",
      url: LOCATION,
      headers: {
        "Content-Range": `bytes 0-${AAB_BYTES.length - 1}/${AAB_BYTES.length}`,
        "Content-Type": "application/octet-stream",
      },
      body: AAB_BYTES.toString(),
    });
    expect(track!.body).toEqual({
      track: "internal",
      releases: [{ versionCodes: ["42"], status: "completed" }],
    });
  });

  it("masks the access token and the service account's private key", async () => {
    const { fetch } = createRecordingFetch(successRoutes());

    await upload(fetch);

    const { private_key } = JSON.parse(serviceAccountJson);
    expect(
      maskSecretValues(`Authorization: Bearer ${ACCESS_TOKEN}`),
    ).not.toContain(ACCESS_TOKEN);
    expect(maskSecretValues(private_key)).not.toContain(
      private_key.split("\n")[1],
    );
  });

  it("uploads to a session on www.googleapis.com, as Google documents", async () => {
    const routes = successRoutes();
    const location = `https://www.googleapis.com/upload/androidpublisher/v3/applications/com.example.app/edits/edit-1/bundles?uploadType=resumable&upload_id=session-1`;
    routes[`POST ${SESSION}`] = { headers: { location } };
    routes[`PUT ${location}`] = { json: { versionCode: 42 } };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(upload(fetch)).resolves.toMatchObject({ versionCode: 42 });
    expect(requests.some((request) => request.url === location)).toBe(true);
  });

  it("refuses an upload session on another host", async () => {
    const routes = successRoutes();
    routes[`POST ${SESSION}`] = {
      headers: { location: "https://upload.example.com/session" },
    };
    routes[`DELETE ${EDIT}`] = { status: 204 };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(upload(fetch)).rejects.toThrow(
      "Google returned no upload session for the .aab.",
    );
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: EDIT });
  });

  it("resumes a chunk at the offset Google confirms after a failure", async () => {
    const routes = successRoutes();
    routes[`PUT ${LOCATION}`] = [
      { status: 503 },
      // The offset query: Google received the first 10 bytes.
      { status: 308, headers: { range: "bytes=0-9" } },
      { json: { versionCode: 42 } },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await upload(fetch);

    const chunks = requests.filter((request) => request.url === LOCATION);
    expect(chunks.map((chunk) => chunk.headers["Content-Range"])).toEqual([
      `bytes 0-${AAB_BYTES.length - 1}/${AAB_BYTES.length}`,
      `bytes */${AAB_BYTES.length}`,
      `bytes 10-${AAB_BYTES.length - 1}/${AAB_BYTES.length}`,
    ]);
    expect(chunks[2]!.body).toBe(AAB_BYTES.subarray(10).toString());
  });

  it("returns the bundle a status query reports complete after the last failed attempt", async () => {
    const routes = successRoutes();
    routes[`PUT ${LOCATION}`] = [
      { status: 503 },
      // Each offset query: Google has nothing yet, then all of it.
      { status: 308 },
      { status: 503 },
      { status: 308 },
      { status: 503 },
      { json: { versionCode: 42 } },
    ];
    const { fetch } = createRecordingFetch(routes);

    await expect(upload(fetch)).resolves.toMatchObject({ versionCode: 42 });
  });

  it("reads a status Range without the bytes= prefix", async () => {
    const routes = successRoutes();
    routes[`PUT ${LOCATION}`] = [
      { status: 503 },
      { status: 308, headers: { range: "0-9" } },
      { json: { versionCode: 42 } },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await upload(fetch);

    expect(
      requests
        .filter((request) => request.url === LOCATION)
        .map((request) => request.headers["Content-Range"]),
    ).toEqual([
      `bytes 0-${AAB_BYTES.length - 1}/${AAB_BYTES.length}`,
      `bytes */${AAB_BYTES.length}`,
      `bytes 10-${AAB_BYTES.length - 1}/${AAB_BYTES.length}`,
    ]);
  });

  it("gives up on a chunk Google keeps none of", async () => {
    const routes = successRoutes();
    // A 308 without Range: Google committed no bytes.
    routes[`PUT ${LOCATION}`] = { status: 308 };
    routes[`DELETE ${EDIT}`] = { status: 204 };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(upload(fetch)).rejects.toThrow(
      "Uploading the .aab failed: Google kept none of a chunk.",
    );
    expect(requests.filter((request) => request.url === LOCATION)).toHaveLength(
      3,
    );
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: EDIT });
  });

  it("commits again while Google is still processing the bundle", async () => {
    const routes = successRoutes();
    routes[`POST ${EDIT}:commit`] = [
      {
        status: 400,
        json: {
          error: {
            message:
              "Some of the Android App Bundle uploads are not completed yet.",
          },
        },
      },
      { json: { id: "edit-1" } },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await upload(fetch);

    expect(
      requests.filter((request) => request.url === `${EDIT}:commit`),
    ).toHaveLength(2);
  });

  it("commits with changesNotSentForReview when the app's state asks for it", async () => {
    const routes = successRoutes();
    routes[`POST ${EDIT}:commit`] = {
      status: 400,
      json: {
        error: {
          message:
            "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.",
        },
      },
    };
    routes[`POST ${EDIT}:commit?changesNotSentForReview=true`] = {
      json: { id: "edit-1" },
    };
    const { fetch, requests } = createRecordingFetch(routes);

    await upload(fetch);

    expect(requests.at(-1)!.url).toBe(
      `${EDIT}:commit?changesNotSentForReview=true`,
    );
    expect(p.log.warn).toHaveBeenCalledWith(
      "Google Play saved the release without sending it for review.\nSend the changes for review in Play Console.",
    );
  });

  it("reports a commit Google did not answer as unconfirmed", async () => {
    const routes = successRoutes();
    routes[`POST ${EDIT}:commit`] = { status: 503 };
    routes[`DELETE ${EDIT}`] = { status: 204 };
    const { fetch } = createRecordingFetch(routes);

    await expect(upload(fetch)).rejects.toThrow(
      "Google Play didn't confirm the release.\nCommitting the Google Play edit failed (HTTP 503).\nCheck internal testing in Play Console before you upload it again.",
    );
  });

  it("releases a draft on an app Play Console has not published", async () => {
    const routes = successRoutes();
    routes[`PUT ${EDIT}/tracks/internal`] = [
      {
        status: 400,
        json: {
          error: {
            message:
              "Only releases with status draft may be created on draft app.",
          },
        },
      },
      { json: { track: "internal" } },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(upload(fetch)).resolves.toEqual({
      versionCode: 42,
      status: "draft",
    });

    const tracks = requests.filter(
      (request) => request.url === `${EDIT}/tracks/internal`,
    );
    expect(tracks.map((track) => track.body)).toEqual([
      {
        track: "internal",
        releases: [{ versionCodes: ["42"], status: "completed" }],
      },
      {
        track: "internal",
        releases: [{ versionCodes: ["42"], status: "draft" }],
      },
    ]);
    expect(requests.at(-1)!.url).toBe(`${EDIT}:commit`);
  });

  it("deletes the edit when Google refuses the bundle, and names the version code to raise", async () => {
    const routes = successRoutes();
    routes[`PUT ${LOCATION}`] = {
      status: 403,
      json: {
        error: {
          message: "APK specifies a version code that has already been used.",
        },
      },
    };
    routes[`DELETE ${EDIT}`] = { status: 204 };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(upload(fetch)).rejects.toThrow(
      "Google Play already has this .aab's version code.\nRaise versionCode for every build you upload.",
    );
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: EDIT });
    expect(requests.some((request) => request.url.includes(":commit"))).toBe(
      false,
    );
  });

  it.each([
    // Google's error document for an APK or bundle whose version code a
    // release of the app already has.
    "APK specifies a version code that has already been used.",
    "Version code 42 has already been used.",
  ])(
    "refuses a version code Google Play already has with a typed error: %s",
    async (message) => {
      const routes = successRoutes();
      routes[`PUT ${LOCATION}`] = {
        status: 403,
        json: {
          error: {
            code: 403,
            message,
            errors: [
              {
                message,
                domain: "androidpublisher",
                reason: "apkUpgradeVersionConflict",
              },
            ],
            status: "PERMISSION_DENIED",
          },
        },
      };
      routes[`DELETE ${EDIT}`] = { status: 204 };
      const { fetch } = createRecordingFetch(routes);

      await expect(upload(fetch)).rejects.toBeInstanceOf(
        PlayVersionCodeUsedError,
      );
    },
  );

  it("names the permission a service account without access needs", async () => {
    const routes = successRoutes();
    routes[`POST ${APP}/edits`] = {
      status: 403,
      json: { error: { message: "The caller does not have permission" } },
    };
    const { fetch } = createRecordingFetch(routes);

    await expect(upload(fetch)).rejects.toThrow(
      "The Play service account can't release com.example.app.\nInvite its email in Play Console (Users and permissions)",
    );
  });

  it("refuses a service account JSON without a key, without echoing it", async () => {
    const { fetch, requests } = createRecordingFetch(successRoutes());
    const failure = uploadToPlay({
      aabPath,
      packageName: "com.example.app",
      serviceAccount: { json: '{"client_email":"x","secret":"leak-me"}' },
      fetch,
    });

    await expect(failure).rejects.toThrow(
      "The Play service account has no client_email or private_key",
    );
    await expect(failure).rejects.not.toThrow("leak-me");
    expect(requests).toHaveLength(0);
  });

  it("uploads with a play-service-account from the secrets adapter, and writes the JSON to no file", async () => {
    // Every temporary file the resolver or the upload could write lands here.
    const tmp = await fs.mkdtemp(path.join(dir, "tmp-"));
    vi.stubEnv("TMPDIR", tmp);
    const get = vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, serviceAccountJson])),
    );
    const resolver = createCredentialResolver({
      secrets: { name: "spec-store", get, set: async () => {} },
      cwd: dir,
    });
    const { fetch, requests } = createRecordingFetch(successRoutes());

    const serviceAccount = await resolver.resolve(
      resolvePlayUploadServiceAccount(scheme()),
    );
    await uploadToPlay({
      aabPath,
      packageName: "com.example.app",
      serviceAccount,
      fetch,
    });
    await resolver.dispose();

    expect(get).toHaveBeenCalledWith(["play-service-account"], { cwd: dir });
    expect(requests.at(-1)!.url).toBe(`${EDIT}:commit`);
    expect(os.tmpdir()).toBe(tmp);
    await expect(fs.readdir(tmp)).resolves.toEqual([]);
  });
});

const scheme = (
  overrides: Partial<NativeBuildAndroidScheme> = {},
): { scheme: string; androidScheme: NativeBuildAndroidScheme } => ({
  scheme: "release",
  androidScheme: { packageName: "com.example.app", ...overrides },
});

describe("resolvePlayUploadServiceAccount", () => {
  it("uploads a release .aab with the play-service-account item", () => {
    expect(resolvePlayUploadServiceAccount(scheme())).toEqual({
      kind: "play-service-account",
      name: "play-service-account",
    });
  });

  it("refuses an .apk scheme", () => {
    expect(() =>
      resolvePlayUploadServiceAccount(scheme({ aab: false })),
    ).toThrow(
      "The scheme release builds an .apk (aab: false); Google Play takes an .aab.",
    );
  });

  it("refuses a debug variant", () => {
    expect(() =>
      resolvePlayUploadServiceAccount(scheme({ variant: "stagingDebug" })),
    ).toThrow(
      "The scheme release builds stagingDebug; Google Play takes a release build.",
    );
  });
});

describe("readPlayInternalRelease", () => {
  const read = (fetch: typeof globalThis.fetch, versionCode: number) =>
    readPlayInternalRelease({
      versionCode,
      packageName: "com.example.app",
      serviceAccount: { json: serviceAccountJson },
      fetch,
    });

  it("says the status of the release that holds the version code, or that none does", async () => {
    const { fetch } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: successRoutes()[`POST ${TOKEN_URI}`]!,
      [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
      [`GET ${EDIT}/tracks/internal`]: {
        json: {
          releases: [
            { status: "draft", versionCodes: ["42"] },
            { status: "completed", versionCodes: ["43"] },
          ],
        },
      },
      [`DELETE ${EDIT}`]: { status: 204 },
    });

    await expect(read(fetch, 42)).resolves.toBe("draft");
    await expect(read(fetch, 43)).resolves.toBe("completed");
    await expect(read(fetch, 41)).resolves.toBeNull();
  });
});

describe("readPlayHighestVersionCode", () => {
  const read = (fetch: typeof globalThis.fetch) =>
    readPlayHighestVersionCode({
      packageName: "com.example.app",
      serviceAccount: { json: serviceAccountJson },
      fetch,
    });

  it("reads the app's bundles in an edit it deletes, committing nothing", async () => {
    const { fetch, requests } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: successRoutes()[`POST ${TOKEN_URI}`]!,
      [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
      [`GET ${EDIT}/bundles`]: {
        json: { bundles: [{ versionCode: 41 }, { versionCode: 7 }] },
      },
      [`DELETE ${EDIT}`]: { status: 204 },
    });

    await expect(read(fetch)).resolves.toBe(41);
    expect(
      requests
        .filter(({ url }) => url !== TOKEN_URI)
        .map(({ method, url }) => `${method} ${url.replace(APP, "")}`),
    ).toEqual([
      "POST /edits",
      "GET /edits/edit-1/bundles",
      "DELETE /edits/edit-1",
    ]);
  });

  it("says none for an app with no bundles", async () => {
    const { fetch } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: successRoutes()[`POST ${TOKEN_URI}`]!,
      [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
      [`GET ${EDIT}/bundles`]: { json: {} },
      [`DELETE ${EDIT}`]: { status: 204 },
    });
    await expect(read(fetch)).resolves.toBeNull();
  });
});

describe("playTestingUrl", () => {
  it("names the app", () => {
    expect(playTestingUrl("com.example.app.sandbox")).toBe(
      "https://play.google.com/apps/testing/com.example.app.sandbox",
    );
  });
});

describe("findPlayInternalRelease", () => {
  const find = (fetch: typeof globalThis.fetch, versionCode = 42) =>
    findPlayInternalRelease({
      versionCode,
      packageName: "com.example.app",
      serviceAccount: { json: serviceAccountJson },
      fetch,
    });

  it("reads the internal track in an edit it deletes, committing nothing", async () => {
    const { fetch, requests } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: successRoutes()[`POST ${TOKEN_URI}`]!,
      [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
      [`GET ${EDIT}/tracks/internal`]: {
        json: {
          track: "internal",
          releases: [{ versionCodes: ["41"] }, { versionCodes: ["42"] }],
        },
      },
      [`DELETE ${EDIT}`]: { status: 204 },
    });

    await expect(find(fetch)).resolves.toBe(true);
    await expect(find(fetch, 43)).resolves.toBe(false);
    expect(
      requests
        .filter(({ url }) => url !== TOKEN_URI)
        .map(({ method, url }) => `${method} ${url.replace(APP, "")}`),
    ).toEqual([
      "POST /edits",
      "GET /edits/edit-1/tracks/internal",
      "DELETE /edits/edit-1",
      "POST /edits",
      "GET /edits/edit-1/tracks/internal",
      "DELETE /edits/edit-1",
    ]);
  });

  it("finds none on a track with no release yet", async () => {
    const { fetch } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: successRoutes()[`POST ${TOKEN_URI}`]!,
      [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
      [`GET ${EDIT}/tracks/internal`]: { json: { track: "internal" } },
      [`DELETE ${EDIT}`]: { status: 204 },
    });

    await expect(find(fetch)).resolves.toBe(false);
  });
});

describe("checkPlayAccess", () => {
  const EMAIL = "uploader@example.iam.gserviceaccount.com";
  const check = (fetch: typeof globalThis.fetch) =>
    checkPlayAccess({
      serviceAccount: { json: serviceAccountJson },
      packageName: "com.example.app",
      fetch,
    });

  it("opens an edit and deletes it when the key reaches the app", async () => {
    const { fetch, requests } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: { json: { access_token: ACCESS_TOKEN } },
      [`POST ${APP}/edits`]: { json: { id: "edit-1" } },
      [`DELETE ${EDIT}`]: { status: 204 },
    });

    await expect(check(fetch)).resolves.toEqual({ status: "ready" });
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${TOKEN_URI}`,
      `POST ${APP}/edits`,
      `DELETE ${EDIT}`,
    ]);
  });

  it("names the email to invite when Google Play refuses the key", async () => {
    const { fetch } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: { json: { access_token: ACCESS_TOKEN } },
      [`POST ${APP}/edits`]: {
        status: 403,
        json: { error: { message: "The caller does not have permission" } },
      },
    });

    await expect(check(fetch)).resolves.toEqual({
      status: "denied",
      email: EMAIL,
    });
  });

  it("finds no app when Google Play answers 404", async () => {
    const { fetch } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: { json: { access_token: ACCESS_TOKEN } },
      [`POST ${APP}/edits`]: {
        status: 404,
        json: { error: { message: "Package not found: com.example.app." } },
      },
    });

    await expect(check(fetch)).resolves.toEqual({
      status: "not-found",
      email: EMAIL,
    });
  });

  it("gives Google's reason when the token endpoint refuses the key", async () => {
    const { fetch, requests } = createRecordingFetch({
      [`POST ${TOKEN_URI}`]: {
        status: 400,
        json: { error: "invalid_grant", error_description: "Invalid JWT" },
      },
    });

    await expect(check(fetch)).resolves.toMatchObject({
      status: "refused",
      email: EMAIL,
      reason: expect.stringContaining("Invalid JWT"),
    });
    expect(requests).toHaveLength(1);
  });

  it("links Play Console's invite of the email", () => {
    expect(playConsoleInviteUrl("a+b@example.com")).toBe(
      "https://play.google.com/console/u/0/developers/_/users-and-permissions?invite=a%2Bb%40example.com",
    );
  });
});
