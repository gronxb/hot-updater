import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const {
    createCredentialResolver,
    parseSecretReference,
    registerSecretValue,
  } = await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    createCredentialResolver,
    parseSecretReference,
    registerSecretValue,
    p: { log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() } },
  };
});
vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("./utils/readIpaInfo", () => ({
  readIpaInfo: vi.fn(async () => ({
    bundleId: "com.example.app",
    shortVersion: "1.2.0",
    bundleVersion: "42",
  })),
}));

import { createCredentialResolver, p } from "@hot-updater/cli-tools";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";

import {
  assertTestFlightExportOptions,
  createAppStoreConnectToken,
  findTestFlightBuild,
  resolveTestFlightUploadKey,
  uploadToTestFlight,
} from "./uploadToTestFlight";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";

const API = "https://api.appstoreconnect.apple.com";
const IPA_BYTES = Buffer.from("0123456789abcdefghij");

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
            ? JSON.parse(body)
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
        return new Response(JSON.stringify({ errors: [] }), { status: 404 });
      }
      const status = reply.status ?? 200;
      return new Response(
        status === 204 || reply.json === undefined
          ? null
          : JSON.stringify(reply.json),
        { status, headers: reply.headers },
      );
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
};

const FILE_STATE_URL = `${API}/v1/buildUploadFiles/file-1?fields[buildUploadFiles]=assetDeliveryState`;
const PART_URL_1 = "https://upload.example.com/part-1?signature=abc";
const PART_URL_2 = "https://upload.example.com/part-2?signature=def";

const appsUrl = `${API}/v1/apps?${new URLSearchParams({
  "filter[bundleId]": "com.example.app",
  "fields[apps]": "bundleId",
})}`;

const successRoutes = (): Record<string, Reply | Reply[]> => ({
  [`GET ${appsUrl}`]: {
    json: {
      data: [
        { id: "999", attributes: { bundleId: "com.example.app.widget" } },
        { id: "123", attributes: { bundleId: "com.example.app" } },
      ],
    },
  },
  [`POST ${API}/v1/buildUploads`]: {
    status: 201,
    json: { data: { id: "upload-1", type: "buildUploads" } },
  },
  [`POST ${API}/v1/buildUploadFiles`]: {
    status: 201,
    json: {
      data: {
        id: "file-1",
        type: "buildUploadFiles",
        attributes: {
          uploadOperations: [
            {
              method: "PUT",
              url: PART_URL_1,
              offset: 0,
              length: 12,
              requestHeaders: [
                { name: "Content-Type", value: "application/octet-stream" },
              ],
            },
            {
              method: "PUT",
              url: PART_URL_2,
              offset: 12,
              length: 8,
              requestHeaders: [{ name: "x-amz-meta-part", value: "2" }],
            },
          ],
        },
      },
    },
  },
  [`PUT ${PART_URL_1}`]: { status: 200 },
  [`PUT ${PART_URL_2}`]: { status: 200 },
  [`PATCH ${API}/v1/buildUploadFiles/file-1`]: {
    json: { data: { id: "file-1", type: "buildUploadFiles" } },
  },
  [`GET ${API}/v1/buildUploads/upload-1`]: [
    { json: { data: { attributes: { state: { state: "PROCESSING" } } } } },
    {
      json: {
        data: {
          attributes: {
            state: {
              state: "COMPLETE",
              warnings: [{ code: "90000", description: "A warning" }],
            },
          },
        },
      },
    },
  ],
});

let dir: string;
let ipaPath: string;
let keyPath: string;
let publicKey: crypto.KeyObject;

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "testflight-"));
  ipaPath = path.join(dir, "App.ipa");
  await fs.writeFile(ipaPath, IPA_BYTES);
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  publicKey = pair.publicKey;
  keyPath = path.join(dir, "AuthKey_KEY123.p8");
  await fs.writeFile(
    keyPath,
    pair.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const apiKey = () => ({ keyPath, keyId: "KEY123", issuerId: "issuer-uuid" });

const decodeToken = (authorization: string) => {
  const token = authorization.replace(/^Bearer /, "");
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
};

describe("createAppStoreConnectToken", () => {
  it("signs an ES256 JWT for App Store Connect with a raw r || s signature", async () => {
    const privateKey = crypto.createPrivateKey(await fs.readFile(keyPath));
    const token = createAppStoreConnectToken({
      privateKey,
      keyId: "KEY123",
      issuerId: "issuer-uuid",
      issuedAtSeconds: 1_700_000_000,
    });

    const { header, payload, signingInput, signature } = decodeToken(token);
    expect(header).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(payload).toEqual({
      iss: "issuer-uuid",
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 20 * 60,
      aud: "appstoreconnect-v1",
    });
    expect(signature).toHaveLength(64);
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(signingInput),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(true);
  });
});

describe("uploadToTestFlight", () => {
  it("uploads the .ipa through App Store Connect's build uploads, in order", async () => {
    const { fetch, requests } = createRecordingFetch(successRoutes());

    const result = await uploadToTestFlight({
      ipaPath,
      apiKey: apiKey(),
      fetch,
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      appId: "123",
      buildUploadId: "upload-1",
      state: "COMPLETE",
      testFlightUrl:
        "https://appstoreconnect.apple.com/apps/123/testflight/ios",
    });
    const sent = requests.map(({ method, url }) => `${method} ${url}`);
    // The parts go out at once, so they finish in either order.
    expect([
      ...sent.slice(0, 3),
      ...sent.slice(3, 5).sort(),
      ...sent.slice(5),
    ]).toEqual([
      `GET ${appsUrl}`,
      `POST ${API}/v1/buildUploads`,
      `POST ${API}/v1/buildUploadFiles`,
      ...[`PUT ${PART_URL_1}`, `PUT ${PART_URL_2}`].sort(),
      `PATCH ${API}/v1/buildUploadFiles/file-1`,
      `GET ${API}/v1/buildUploads/upload-1`,
      `GET ${API}/v1/buildUploads/upload-1`,
    ]);
    expect(requests[1]!.body).toEqual({
      data: {
        type: "buildUploads",
        attributes: {
          platform: "IOS",
          cfBundleShortVersionString: "1.2.0",
          cfBundleVersion: "42",
        },
        relationships: { app: { data: { type: "apps", id: "123" } } },
      },
    });
    expect(requests[2]!.body).toEqual({
      data: {
        type: "buildUploadFiles",
        attributes: {
          assetType: "ASSET",
          fileName: "App.ipa",
          fileSize: IPA_BYTES.length,
          uti: "com.apple.ipa",
        },
        relationships: {
          buildUpload: { data: { type: "buildUploads", id: "upload-1" } },
        },
      },
    });
    expect(requests[5]!.body).toEqual({
      data: {
        type: "buildUploadFiles",
        id: "file-1",
        attributes: { uploaded: true },
      },
    });
    expect(p.log.warn).toHaveBeenCalledWith("A warning (90000)");
  });

  it("uploads with an asc-api-key from the secrets adapter, whose key file is gone afterwards", async () => {
    const value = JSON.stringify({
      keyId: "KEY123",
      issuerId: "issuer-uuid",
      p8: await fs.readFile(keyPath, "utf-8"),
    });
    const get = vi.fn(async (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, value])),
    );
    const resolver = createCredentialResolver({
      secrets: { name: "spec-store", get },
      cwd: dir,
    });
    const { fetch, requests } = createRecordingFetch(successRoutes());

    const key = await resolver.resolve({ kind: "asc-api-key" });
    expect(key.keyPath).not.toBe(keyPath);
    expect((await fs.stat(key.keyPath)).mode & 0o777).toBe(0o600);
    await uploadToTestFlight({
      ipaPath,
      apiKey: key,
      fetch,
      pollIntervalMs: 0,
    });
    await resolver.dispose();

    expect(get).toHaveBeenCalledWith(["asc-api-key"], { cwd: dir });
    const { signingInput, signature } = decodeToken(
      requests[0]!.headers["Authorization"]!,
    );
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(signingInput),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(true);
    expect(requests.at(-1)!.url).toBe(`${API}/v1/buildUploads/upload-1`);
    await expect(fs.stat(key.keyPath)).rejects.toThrow("ENOENT");
  });

  it("authenticates API requests with the key's token, and never the presigned parts", async () => {
    const { fetch, requests } = createRecordingFetch(successRoutes());

    await uploadToTestFlight({
      ipaPath,
      apiKey: apiKey(),
      fetch,
      pollIntervalMs: 0,
    });

    for (const request of requests) {
      if (request.url.startsWith(API)) {
        const { header, payload, signingInput, signature } = decodeToken(
          request.headers["Authorization"]!,
        );
        expect(header.kid).toBe("KEY123");
        expect(payload.iss).toBe("issuer-uuid");
        expect(
          crypto.verify(
            "sha256",
            Buffer.from(signingInput),
            { key: publicKey, dsaEncoding: "ieee-p1363" },
            signature,
          ),
        ).toBe(true);
      }
    }
    // Parts upload concurrently, so they arrive in either order.
    const parts = requests
      .filter((request) => !request.url.startsWith(API))
      .sort((a, b) => a.url.localeCompare(b.url));
    expect(parts).toEqual([
      {
        method: "PUT",
        url: PART_URL_1,
        headers: { "Content-Type": "application/octet-stream" },
        body: IPA_BYTES.subarray(0, 12).toString(),
      },
      {
        method: "PUT",
        url: PART_URL_2,
        headers: { "x-amz-meta-part": "2" },
        body: IPA_BYTES.subarray(12, 20).toString(),
      },
    ]);
  });

  it("retries a part the upload server failed", async () => {
    const routes = successRoutes();
    routes[`PUT ${PART_URL_2}`] = [{ status: 503 }, { status: 200 }];
    const { fetch, requests } = createRecordingFetch(routes);
    const started = Date.now();

    await uploadToTestFlight({
      ipaPath,
      apiKey: apiKey(),
      fetch,
      pollIntervalMs: 0,
    });

    expect(
      requests.filter((request) => request.url === PART_URL_2),
    ).toHaveLength(2);
    // Without Retry-After, the part waits the backoff before it goes again.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("sends a rate-limited part again after the Retry-After it asks for", async () => {
    const routes = successRoutes();
    routes[`PUT ${PART_URL_1}`] = [
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200 },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(
      requests.filter((request) => request.url === PART_URL_1),
    ).toHaveLength(2);
  });

  it("removes the build upload when a part is refused, so the build number stays free", async () => {
    const routes = successRoutes();
    routes[`PUT ${PART_URL_2}`] = { status: 403 };
    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = { status: 204 };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Uploading part 2 of 2 failed: HTTP 403.");

    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${API}/v1/buildUploads/upload-1`,
    });
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("keeps an upload whose unanswered commit App Store Connect applied", async () => {
    const routes = successRoutes();
    routes[`PATCH ${API}/v1/buildUploadFiles/file-1`] = { status: 503 };
    routes[`GET ${FILE_STATE_URL}`] = {
      json: {
        data: {
          attributes: { assetDeliveryState: { state: "UPLOAD_COMPLETE" } },
        },
      },
    };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(
      requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("commits again when App Store Connect still awaits the upload", async () => {
    const routes = successRoutes();
    routes[`PATCH ${API}/v1/buildUploadFiles/file-1`] = [
      { status: 503 },
      { json: { data: { id: "file-1", type: "buildUploadFiles" } } },
    ];
    routes[`GET ${FILE_STATE_URL}`] = {
      json: {
        data: {
          attributes: { assetDeliveryState: { state: "AWAITING_UPLOAD" } },
        },
      },
    };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(
      requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(2);
  });

  it("removes the upload when App Store Connect refuses the commit", async () => {
    const routes = successRoutes();
    routes[`PATCH ${API}/v1/buildUploadFiles/file-1`] = {
      status: 409,
      json: {
        errors: [{ status: "409", detail: "The file is not complete." }],
      },
    };
    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = { status: 204 };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "Committing the .ipa upload failed (HTTP 409): The file is not complete.",
    );
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: `${API}/v1/buildUploads/upload-1`,
    });
  });

  it("never removes an upload whose commit it cannot confirm", async () => {
    const routes = successRoutes();
    routes[`PATCH ${API}/v1/buildUploadFiles/file-1`] = { status: 503 };
    routes[`GET ${FILE_STATE_URL}`] = { status: 503 };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect did not confirm the upload of build 42: Committing the .ipa upload failed (HTTP 503). Check the build in TestFlight before you upload it again: https://appstoreconnect.apple.com/apps/123/testflight/ios",
    );
    expect(
      requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(3);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("sends an unanswered create again", async () => {
    const routes = successRoutes();
    routes[`POST ${API}/v1/buildUploads`] = [
      { status: 503 },
      { status: 201, json: { data: { id: "upload-1", type: "buildUploads" } } },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ buildUploadId: "upload-1" });
    expect(
      requests.filter((request) => request.url === `${API}/v1/buildUploads`),
    ).toHaveLength(2);
  });

  it("takes no reservation it cannot show is its own after an unanswered create", async () => {
    const routes = successRoutes();
    routes[`POST ${API}/v1/buildUploads`] = [
      { status: 503 },
      {
        status: 409,
        json: {
          errors: [
            { status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE" },
          ],
        },
      },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect already has build 42 of version 1.2.0, which a request of this upload it did not answer may have reserved. Upload with a new build number (CFBundleVersion).",
    );
    // Nothing is uploaded into, committed, or removed.
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "POST",
    ]);
  });
  it("lets the parts in flight settle, and starts no other, before it removes the upload", async () => {
    const routes = successRoutes();
    const operations = Array.from({ length: 6 }, (_, index) => ({
      method: "PUT",
      url: `https://upload.example.com/part-${index + 1}`,
      offset: index * 3,
      length: 3,
    }));
    routes[`POST ${API}/v1/buildUploadFiles`] = {
      status: 201,
      json: {
        data: { id: "file-1", attributes: { uploadOperations: operations } },
      },
    };
    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = { status: 204 };
    const settled: string[] = [];
    const { fetch: recording, requests } = createRecordingFetch(routes);
    const fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "https://upload.example.com/part-1") {
        return new Response(null, { status: 403 });
      }
      if (url.startsWith("https://upload.example.com/")) {
        // The other parts in flight answer after part 1 failed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        settled.push(url);
        return new Response(null, { status: 200 });
      }
      if (init?.method === "DELETE") {
        settled.push("DELETE");
      }
      return recording(input, init);
    }) as typeof globalThis.fetch;

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Uploading part 1 of 6 failed: HTTP 403.");

    // Parts 2-4 were in flight with part 1; parts 5 and 6 never started.
    expect(settled).toHaveLength(4);
    expect(settled.slice(0, 3).sort()).toEqual([
      "https://upload.example.com/part-2",
      "https://upload.example.com/part-3",
      "https://upload.example.com/part-4",
    ]);
    expect(settled[3]).toBe("DELETE");
    expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("removes the upload again when the removal is rate limited, and names one it could not remove", async () => {
    const routes = successRoutes();
    routes[`PUT ${PART_URL_2}`] = { status: 403 };
    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = [
      { status: 429, headers: { "retry-after": "0" } },
      { status: 204 },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Uploading part 2 of 2 failed: HTTP 403.");
    expect(
      requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(2);
    expect(p.log.warn).not.toHaveBeenCalled();

    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = { status: 403 };
    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Uploading part 2 of 2 failed: HTTP 403.");
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "App Store Connect kept the unfinished build upload upload-1, which reserves build 42 of version 1.2.0:",
      ),
    );
  });

  it("takes a 404 from an upload removal sent again as removed", async () => {
    const routes = successRoutes();
    routes[`PUT ${PART_URL_2}`] = { status: 403 };
    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = [
      { status: 503 },
      { status: 404, json: { errors: [{ status: "404", code: "NOT_FOUND" }] } },
    ];
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Uploading part 2 of 2 failed: HTTP 403.");
    expect(p.log.warn).not.toHaveBeenCalled();
  });

  it("never removes an upload after an unanswered commit, even when the next commit is refused", async () => {
    const routes = successRoutes();
    routes[`PATCH ${API}/v1/buildUploadFiles/file-1`] = [
      { status: 503 },
      {
        status: 409,
        json: {
          errors: [{ status: "409", detail: "The upload is processing." }],
        },
      },
    ];
    // The state read is rate limited throughout, so the commit stays unknown.
    routes[`GET ${FILE_STATE_URL}`] = {
      status: 429,
      headers: { "retry-after": "0" },
    };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect did not confirm the upload of build 42: Committing the .ipa upload failed (HTTP 409): The upload is processing.",
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("waits the Retry-After a rate-limited commit asks for", async () => {
    const routes = successRoutes();
    routes[`PATCH ${API}/v1/buildUploadFiles/file-1`] = [
      { status: 429, headers: { "retry-after": "1" } },
      { json: { data: { id: "file-1", type: "buildUploadFiles" } } },
    ];
    routes[`GET ${FILE_STATE_URL}`] = {
      json: {
        data: {
          attributes: { assetDeliveryState: { state: "AWAITING_UPLOAD" } },
        },
      },
    };
    const { fetch } = createRecordingFetch(routes);
    const started = Date.now();

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("sends a part that timed out again", async () => {
    const routes = successRoutes();
    routes[`PUT ${PART_URL_1}`] = [{ status: 408 }, { status: 200 }];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(
      requests.filter((request) => request.url === PART_URL_1),
    ).toHaveLength(2);
  });

  it("creates again after a rate limit, whose duplicate is another build's", async () => {
    const routes = successRoutes();
    routes[`POST ${API}/v1/buildUploads`] = [
      { status: 429, headers: { "retry-after": "0" } },
      { status: 201, json: { data: { id: "upload-1", type: "buildUploads" } } },
    ];
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ buildUploadId: "upload-1" });

    routes[`POST ${API}/v1/buildUploads`] = [
      { status: 429, headers: { "retry-after": "0" } },
      {
        status: 409,
        json: {
          errors: [
            { status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE" },
          ],
        },
      },
    ];
    const second = createRecordingFetch(routes);
    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch: second.fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect already has build 42 of version 1.2.0. Each build of a version needs a new build number (CFBundleVersion).",
    );
  });
  it("finds the app again after a rate limit", async () => {
    const routes = successRoutes();
    routes[`GET ${appsUrl}`] = [
      { status: 429, headers: { "retry-after": "0" } },
      successRoutes()[`GET ${appsUrl}`] as Reply,
    ];
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ appId: "123" });
  });

  it("waits the Retry-After of a rate-limited state read before reading again", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = [
      { status: 429, headers: { "retry-after": "1" } },
      { json: { data: { attributes: { state: { state: "COMPLETE" } } } } },
    ];
    const { fetch } = createRecordingFetch(routes);
    const started = Date.now();

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("reserves the file again after a rate limit, and not after a server error", async () => {
    const routes = successRoutes();
    const reservation = successRoutes()[
      `POST ${API}/v1/buildUploadFiles`
    ] as Reply;
    routes[`POST ${API}/v1/buildUploadFiles`] = [
      { status: 429, headers: { "retry-after": "0" } },
      reservation,
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
    expect(
      requests.filter(
        (request) => request.url === `${API}/v1/buildUploadFiles`,
      ),
    ).toHaveLength(2);

    routes[`POST ${API}/v1/buildUploadFiles`] = { status: 503 };
    routes[`DELETE ${API}/v1/buildUploads/upload-1`] = { status: 204 };
    const second = createRecordingFetch(routes);
    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch: second.fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("Reserving the .ipa upload failed (HTTP 503).");
    expect(
      second.requests.filter(
        (request) => request.url === `${API}/v1/buildUploadFiles`,
      ),
    ).toHaveLength(1);
  });

  it("names the build number App Store Connect already has", async () => {
    const routes = successRoutes();
    routes[`POST ${API}/v1/buildUploads`] = {
      status: 409,
      json: {
        errors: [
          {
            status: "409",
            code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE",
            detail: "The bundle version must be higher.",
          },
        ],
      },
    };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect already has build 42 of version 1.2.0. Each build of a version needs a new build number (CFBundleVersion).",
    );
    expect(requests).toHaveLength(2);
  });

  it("refuses a bundle ID the key cannot see", async () => {
    const routes = successRoutes();
    routes[`GET ${appsUrl}`] = {
      json: {
        data: [
          { id: "999", attributes: { bundleId: "com.example.app.widget" } },
        ],
      },
    };
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect has no app with the bundle ID com.example.app that this API key can see.",
    );
    expect(requests).toHaveLength(1);
  });

  it("reports App Store Connect's errors for a build it rejects", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = {
      json: {
        data: {
          attributes: {
            state: {
              state: "FAILED",
              errors: [
                {
                  code: "90683",
                  description: "Missing purpose string in Info.plist.",
                },
              ],
            },
          },
        },
      },
    };
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect rejected build 42 of version 1.2.0 (FAILED).\n- Missing purpose string in Info.plist. (90683)",
    );
  });

  it("keeps waiting through a failed read of an uploaded build", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = [
      { status: 503 },
      { json: { data: { attributes: { state: { state: "COMPLETE" } } } } },
    ];
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "COMPLETE" });
  });

  it("fails a timeout in which App Store Connect never reported the build's state", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = { status: 503 };
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
        processingTimeoutMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect did not report build 42 processing: Reading the build upload failed (HTTP 503). Check the build in TestFlight: https://appstoreconnect.apple.com/apps/123/testflight/ios",
    );
  });

  it("fails a timeout in which the upload only awaited its file", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = {
      json: { data: { attributes: { state: { state: "AWAITING_UPLOAD" } } } },
    };
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
        processingTimeoutMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect did not report build 42 processing (AWAITING_UPLOAD). Check the build in TestFlight",
    );
  });

  it("stops waiting when App Store Connect refuses the key while it processes", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = [
      { json: { data: { attributes: { state: { state: "PROCESSING" } } } } },
      {
        status: 401,
        json: { errors: [{ status: "401", code: "NOT_AUTHORIZED" }] },
      },
    ];
    const { fetch, requests } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow("App Store Connect refused the API key");
    expect(
      requests.filter(
        (request) => request.url === `${API}/v1/buildUploads/upload-1`,
      ),
    ).toHaveLength(2);
  });

  it("names what to check when App Store Connect refuses the key", async () => {
    const routes = successRoutes();
    routes[`GET ${appsUrl}`] = {
      status: 401,
      json: { errors: [{ status: "401", code: "NOT_AUTHORIZED" }] },
    };
    const { fetch } = createRecordingFetch(routes);

    await expect(
      uploadToTestFlight({
        ipaPath,
        apiKey: apiKey(),
        fetch,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(
      "App Store Connect refused the API key: check its key ID and issuer ID, and that the key is not revoked.",
    );
  });

  it("returns a build App Store Connect is still processing after the timeout", async () => {
    const routes = successRoutes();
    routes[`GET ${API}/v1/buildUploads/upload-1`] = {
      json: { data: { attributes: { state: { state: "PROCESSING" } } } },
    };
    const { fetch } = createRecordingFetch(routes);

    const result = await uploadToTestFlight({
      ipaPath,
      apiKey: apiKey(),
      fetch,
      pollIntervalMs: 0,
      processingTimeoutMs: 0,
    });

    expect(result.state).toBe("PROCESSING");
    expect(p.log.warn).toHaveBeenCalledWith(
      "App Store Connect is still processing build 42. It appears in TestFlight once processing finishes: https://appstoreconnect.apple.com/apps/123/testflight/ios",
    );
  });

  it("refuses a key file that is no private key without echoing it", async () => {
    await fs.writeFile(keyPath, "not-a-key-secret");
    const { fetch, requests } = createRecordingFetch(successRoutes());

    const failure = uploadToTestFlight({ ipaPath, apiKey: apiKey(), fetch });

    await expect(failure).rejects.toThrow(
      "The App Store Connect API key is not a .p8 private key.",
    );
    await expect(failure).rejects.not.toThrow("not-a-key-secret");
    expect(requests).toHaveLength(0);
  });
});

const scheme = (
  overrides: Partial<EnrichedNativeBuildIosScheme> = {},
): EnrichedNativeBuildIosScheme => ({
  bundleIdentifier: "com.example.app",
  scheme: "App",
  platform: "ios",
  installPods: false,
  configuration: "Release",
  destination: [],
  simulator: false,
  hotUpdaterSchemeName: "release",
  ...overrides,
});

const iosScheme = (
  overrides: Partial<NativeBuildIosScheme> = {},
): { scheme: string; iosScheme: NativeBuildIosScheme } => ({
  scheme: "release",
  iosScheme: {
    bundleIdentifier: "com.example.app",
    scheme: "App",
    ...overrides,
  },
});

describe("resolveTestFlightUploadKey", () => {
  it("uploads with the key the scheme signs with", () => {
    expect(
      resolveTestFlightUploadKey(
        iosScheme({ signing: { ascApiKey: "secret:team-asc-key" } }),
      ),
    ).toEqual({ kind: "asc-api-key", name: "team-asc-key" });
  });

  it("uploads with the asc-api-key item for a scheme with its own export options", () => {
    expect(
      resolveTestFlightUploadKey(
        iosScheme({ exportOptionsPlist: "ExportOptions.plist" }),
      ),
    ).toEqual({ kind: "asc-api-key", name: "asc-api-key" });
    // The file may not exist until the adapter's prebuild writes it.
    expect(execa).not.toHaveBeenCalled();
  });

  it("refuses a simulator scheme", () => {
    expect(() =>
      resolveTestFlightUploadKey(
        iosScheme({
          simulator: true,
          signing: { ascApiKey: "secret:asc-api-key" },
        }),
      ),
    ).toThrow(
      "TestFlight takes an .ipa, and the scheme release builds a simulator .app.",
    );
  });

  it("refuses a Debug configuration", () => {
    expect(() =>
      resolveTestFlightUploadKey(
        iosScheme({
          configuration: "StagingDebug",
          signing: { ascApiKey: "secret:asc-api-key" },
        }),
      ),
    ).toThrow(
      "TestFlight takes a release build, and the scheme release builds the StagingDebug configuration, which loads its JavaScript from Metro.",
    );
  });

  it("refuses a scheme that only archives", () => {
    expect(() => resolveTestFlightUploadKey(iosScheme())).toThrow(
      "The scheme release archives without exporting an .ipa. Set signing.ascApiKey, or an exportOptionsPlist with the method app-store-connect.",
    );
  });
});

describe("assertTestFlightExportOptions", () => {
  it("accepts export options for App Store Connect", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: "app-store-connect\n",
      exitCode: 0,
    } as never);

    await expect(
      assertTestFlightExportOptions(
        scheme({ exportOptionsPlist: "/project/ExportOptions.plist" }),
      ),
    ).resolves.toBeUndefined();
    expect(execa).toHaveBeenCalledWith(
      "plutil",
      ["-extract", "method", "raw", "-o", "-", "/project/ExportOptions.plist"],
      { reject: false },
    );
  });

  it("refuses export options of another method", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: "ad-hoc\n",
      exitCode: 0,
    } as never);

    await expect(
      assertTestFlightExportOptions(
        scheme({ exportOptionsPlist: "/project/ExportOptions.plist" }),
      ),
    ).rejects.toThrow(
      "TestFlight takes an .ipa exported for App Store Connect, and the scheme release's exportOptionsPlist exports with the method ad-hoc. Set its method to app-store-connect.",
    );
  });

  it("reads nothing for a scheme that exports with the API key", async () => {
    await assertTestFlightExportOptions(
      scheme({ signing: { ascApiKey: "secret:asc-api-key" } }),
    );
    expect(execa).not.toHaveBeenCalled();
  });
});

describe("findTestFlightBuild", () => {
  const buildsUrl = `${API}/v1/builds?${new URLSearchParams({
    "filter[app]": "123",
    "filter[version]": "42",
    "filter[preReleaseVersion.version]": "1.2.0",
    "fields[builds]": "version",
    limit: "1",
  })}`;

  it("finds the .ipa's build number of its version, reading only", async () => {
    const { fetch, requests } = createRecordingFetch({
      [`GET ${appsUrl}`]: successRoutes()[`GET ${appsUrl}`]!,
      [`GET ${buildsUrl}`]: { json: { data: [{ id: "build-1" }] } },
    });

    await expect(
      findTestFlightBuild({ ipaPath: "/out/App.ipa", apiKey: apiKey(), fetch }),
    ).resolves.toEqual({
      found: true,
      testFlightUrl:
        "https://appstoreconnect.apple.com/apps/123/testflight/ios",
      shortVersion: "1.2.0",
      bundleVersion: "42",
    });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
  });

  it("finds none when App Store Connect has no build of that number", async () => {
    const { fetch } = createRecordingFetch({
      [`GET ${appsUrl}`]: successRoutes()[`GET ${appsUrl}`]!,
      [`GET ${buildsUrl}`]: { json: { data: [] } },
    });

    await expect(
      findTestFlightBuild({ ipaPath: "/out/App.ipa", apiKey: apiKey(), fetch }),
    ).resolves.toMatchObject({ found: false });
  });
});
