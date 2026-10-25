import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maskSecretValues } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  googleAuth: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: mocks.googleAuth.mockImplementation(function () {
    return { getAccessToken: mocks.getAccessToken };
  }),
}));

import { createGoogleAccessToken } from "./googleAccessToken";

const OIDC_URL =
  "https://pipelines.actions.githubusercontent.com/token?api-version=2.0&audience=https%3A%2F%2Fiam.googleapis.com%2Fprojects%2F1%2Flocations%2Fglobal%2FworkloadIdentityPools%2Fgithub%2Fproviders%2Frepo";
const AUDIENCE =
  "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/github/providers/repo";
const IMPERSONATION_URL =
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/ci@demo.iam.gserviceaccount.com:generateAccessToken";

let dir: string;

/** The file google-github-actions/auth writes for Workload Identity Federation. */
const writeExternalAccount = async (extra: Record<string, unknown> = {}) => {
  const file = path.join(dir, "gha-creds.json");
  await fs.writeFile(
    file,
    JSON.stringify({
      type: "external_account",
      audience: AUDIENCE,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      credential_source: {
        url: OIDC_URL,
        headers: { Authorization: "Bearer gha-request-token" },
        format: { type: "json", subject_token_field_name: "value" },
      },
      ...extra,
    }),
  );
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
};

const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  expect(init.redirect).toBe("error");
  if (url === OIDC_URL) {
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer gha-request-token",
    );
    return Response.json({ value: "github-oidc-jwt-subject" });
  }
  if (url === "https://sts.googleapis.com/v1/token") {
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: AUDIENCE,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: "github-oidc-jwt-subject",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    });
    return Response.json({
      access_token: "federated-sts-token",
      expires_in: 3600,
      token_type: "Bearer",
    });
  }
  if (url === IMPERSONATION_URL) {
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer federated-sts-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      scope: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    return Response.json({
      accessToken: "impersonated-service-account-token",
      expireTime: new Date(Date.now() + 3600_000).toISOString(),
    });
  }
  throw new Error(`unexpected ${url}`);
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-gcp-token-"));
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CLOUDSDK_AUTH_ACCESS_TOKEN", "");
  vi.stubEnv("GOOGLE_OAUTH_ACCESS_TOKEN", "");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("createGoogleAccessToken", () => {
  it("uses an access token from the environment as it is", async () => {
    vi.stubEnv("GOOGLE_OAUTH_ACCESS_TOKEN", "env-access-token-1");

    await expect(createGoogleAccessToken("spec")()).resolves.toBe(
      "env-access-token-1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.googleAuth).not.toHaveBeenCalled();
    expect(maskSecretValues("env-access-token-1")).toBe("********");
  });

  it("exchanges a Workload Identity Federation file for a federated token, once", async () => {
    await writeExternalAccount();
    const accessToken = createGoogleAccessToken("spec");

    await expect(accessToken()).resolves.toBe("federated-sts-token");
    await expect(accessToken()).resolves.toBe("federated-sts-token");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      OIDC_URL,
      "https://sts.googleapis.com/v1/token",
    ]);
    expect(mocks.googleAuth).not.toHaveBeenCalled();
    expect(
      maskSecretValues("github-oidc-jwt-subject federated-sts-token"),
    ).toBe("******** ********");
  });

  it("impersonates the service account the file names", async () => {
    await writeExternalAccount({
      service_account_impersonation_url: IMPERSONATION_URL,
    });

    await expect(createGoogleAccessToken("spec")()).resolves.toBe(
      "impersonated-service-account-token",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses a token URL that is not https", async () => {
    await writeExternalAccount({ token_url: "http://sts.example.com/token" });

    await expect(createGoogleAccessToken("spec")()).rejects.toThrow(
      "The Workload Identity Federation token_url must be an https URL.",
    );
  });

  it("reports the token exchange's error without the subject token", async () => {
    await writeExternalAccount();
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ value: "github-oidc-jwt-subject" }),
    );
    fetchMock.mockImplementationOnce(async () =>
      Response.json(
        {
          error: "invalid_grant",
          error_description: "The audience does not match.",
        },
        { status: 400 },
      ),
    );

    const error = await createGoogleAccessToken("spec")().then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe(
      "Google's Workload Identity Federation token exchange failed (400 invalid_grant: The audience does not match.).",
    );
  });

  it("falls back to Application Default Credentials through google-auth-library", async () => {
    mocks.getAccessToken.mockResolvedValue("adc-user-access-token");

    await expect(createGoogleAccessToken("spec")()).resolves.toBe(
      "adc-user-access-token",
    );
    expect(mocks.googleAuth).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    expect(maskSecretValues("adc-user-access-token")).toBe("********");
  });

  it("leaves a service account key file to google-auth-library", async () => {
    const file = path.join(dir, "key.json");
    await fs.writeFile(file, JSON.stringify({ type: "service_account" }));
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
    mocks.getAccessToken.mockResolvedValue("service-account-token");

    await expect(createGoogleAccessToken("spec")()).resolves.toBe(
      "service-account-token",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells how to sign in when ADC has no credentials", async () => {
    mocks.getAccessToken.mockRejectedValue(
      new Error("Could not load the default credentials."),
    );

    await expect(createGoogleAccessToken("spec")()).rejects.toThrow(
      "spec found no Google credentials: sign in with `gcloud auth application-default login`",
    );
  });

  it("names the optional package when it is not installed", async () => {
    vi.resetModules();
    vi.doMock("google-auth-library", () => {
      throw new Error("Cannot find package 'google-auth-library'");
    });
    const fresh = await import("./googleAccessToken");

    await expect(fresh.createGoogleAccessToken("spec")()).rejects.toThrow(
      "spec reads Application Default Credentials through the optional google-auth-library package. Install it (npm install google-auth-library --save-dev)",
    );
    vi.doUnmock("google-auth-library");
  });
});
