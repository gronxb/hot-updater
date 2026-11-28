import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { secretManager } from "./secretManager";

const API = "https://secretmanager.googleapis.com/v1/";
const IMPERSONATED_TOKEN = "ya29.spec-impersonated-service-account-token";

let server: Server;
let base: string;
let dir: string;
/** Every request the flow sends: to the local endpoints, and through fetch. */
let requests: string[];

beforeEach(async () => {
  requests = [];
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/oidc") {
        response.end(JSON.stringify({ value: "github-oidc-jwt" }));
      } else if (request.url === "/sts") {
        response.end(
          JSON.stringify({
            access_token: "ya29.spec-federated-token",
            expires_in: 3600,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
          }),
        );
      } else if (request.url === "/impersonate") {
        response.end(
          JSON.stringify({
            accessToken: IMPERSONATED_TOKEN,
            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hot-updater-wif-"));

  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(base)) requests.push(`fetch ${url}`);
      if (url.startsWith(API)) {
        const authorization = new Headers(init?.headers).get("authorization");
        return authorization === `Bearer ${IMPERSONATED_TOKEN}`
          ? Response.json(
              { error: { code: 404, status: "NOT_FOUND" } },
              { status: 404 },
            )
          : Response.json(
              { error: { code: 401, status: "UNAUTHENTICATED" } },
              { status: 401 },
            );
      }
      if (!url.startsWith(base)) {
        return Response.json(
          { error: { code: 403, status: "PERMISSION_DENIED" } },
          { status: 403 },
        );
      }
      return realFetch(input, init);
    }),
  );
  vi.stubEnv("CLOUDSDK_AUTH_ACCESS_TOKEN", "");
  vi.stubEnv("GOOGLE_OAUTH_ACCESS_TOKEN", "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { force: true, recursive: true });
  await new Promise((resolve) => server.close(resolve));
});

describe("secretManager with Workload Identity Federation", () => {
  it("signs with the impersonated service account's token, and looks up no project", async () => {
    // The file google-github-actions/auth writes, with its endpoints local.
    const file = path.join(dir, "credentials.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: "external_account",
        audience:
          "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/github/providers/app",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: `${base}/sts`,
        service_account_impersonation_url: `${base}/impersonate`,
        credential_source: {
          url: `${base}/oidc`,
          headers: { Authorization: "Bearer github-request-token" },
          format: { type: "json", subject_token_field_name: "value" },
        },
      }),
    );
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", file);

    await expect(
      secretManager({ projectId: "demo-project" }).get(["asc-api-key"], {
        cwd: dir,
      }),
    ).resolves.toEqual({ "asc-api-key": undefined });

    expect(requests).toEqual([
      "GET /oidc",
      "POST /sts",
      "POST /impersonate",
      `fetch ${API}projects/demo-project/secrets/hot-updater-asc-api-key/versions/latest:access`,
    ]);
  });
});
