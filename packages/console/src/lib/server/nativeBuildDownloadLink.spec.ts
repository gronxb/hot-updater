// @vitest-environment node

import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guard } = vi.hoisted(() => ({
  guard: { current: undefined as (() => undefined) | undefined },
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://console.example.com/_serverFn/x"),
}));
vi.mock("virtual:hot-updater-console/request-guard", () => ({
  get default() {
    return guard.current;
  },
}));

import {
  CONSOLE_SECRET_ENV,
  createNativeBuildDownloadToken,
  issueNativeBuildDownloadLink,
  NATIVE_BUILD_DOWNLOAD_LINK_TTL_MS,
  readConsoleSecret,
  refuseNativeBuildDownloadToken,
  verifyNativeBuildDownloadToken,
} from "./nativeBuildDownloadLink";

const SECRET = "a-console-secret-of-at-least-32-characters";
const BUILD = "019a0000-0000-7000-8000-00000000b001";
const OTHER_BUILD = "019a0000-0000-7000-8000-00000000b002";
const NOW = Date.UTC(2026, 9, 31);
const LATER = NOW + 60_000;
const request = () => new Request("https://console.example.com/download");

const flipped = (char: string) => (char === "A" ? "B" : "A");

beforeEach(() => {
  guard.current = undefined;
  vi.stubEnv(CONSOLE_SECRET_ENV, SECRET);
});

afterEach(() => vi.unstubAllEnvs());

describe("the download token", () => {
  it("holds its expiry in seconds and a base64url signature, not the build", async () => {
    const token = await createNativeBuildDownloadToken(SECRET, BUILD, LATER);

    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    expect(token.split(".")[0]).toBe(String(LATER / 1000));
    expect(token).not.toContain(BUILD);
  });

  it("verifies until the second it expires", async () => {
    const token = await createNativeBuildDownloadToken(SECRET, BUILD, LATER);

    await expect(
      verifyNativeBuildDownloadToken(SECRET, BUILD, token, NOW),
    ).resolves.toBe("valid");
    await expect(
      verifyNativeBuildDownloadToken(SECRET, BUILD, token, LATER - 1),
    ).resolves.toBe("valid");
    await expect(
      verifyNativeBuildDownloadToken(SECRET, BUILD, token, LATER),
    ).resolves.toBe("expired");
  });

  it("binds one build and one secret", async () => {
    const token = await createNativeBuildDownloadToken(SECRET, BUILD, LATER);

    await expect(
      verifyNativeBuildDownloadToken(SECRET, OTHER_BUILD, token, NOW),
    ).resolves.toBe("invalid");
    await expect(
      verifyNativeBuildDownloadToken(`${SECRET}-rotated`, BUILD, token, NOW),
    ).resolves.toBe("invalid");
  });

  it("refuses any changed character, the signature's last included", async () => {
    const token = await createNativeBuildDownloadToken(SECRET, BUILD, LATER);

    for (let index = 0; index < token.length; index += 1) {
      const tampered = `${token.slice(0, index)}${flipped(token[index]!)}${token.slice(index + 1)}`;
      await expect(
        verifyNativeBuildDownloadToken(SECRET, BUILD, tampered, NOW),
      ).resolves.toBe("invalid");
    }
  });

  it("calls an extended expiry invalid, not valid or expired", async () => {
    const token = await createNativeBuildDownloadToken(SECRET, BUILD, LATER);
    const [, signature] = token.split(".");

    await expect(
      verifyNativeBuildDownloadToken(
        SECRET,
        BUILD,
        `${LATER / 1000 + 86_400}.${signature}`,
        NOW,
      ),
    ).resolves.toBe("invalid");
  });

  it("refuses what isn't a token at all", async () => {
    for (const token of ["", ".", "123", "123.", ".sig", "abc.def", "1.2.3"]) {
      await expect(
        verifyNativeBuildDownloadToken(SECRET, BUILD, token, NOW),
      ).resolves.toBe("invalid");
    }
  });

  it("never verifies a signature made with the Console's secret itself", async () => {
    // The key is derived, so nothing the sessions sign can pass as a link.
    const expiry = String(LATER / 1000);
    const signature = createHmac("sha256", SECRET)
      .update(`native-build-download\n${BUILD}\n${expiry}`)
      .digest("base64url");

    await expect(
      verifyNativeBuildDownloadToken(
        SECRET,
        BUILD,
        `${expiry}.${signature}`,
        NOW,
      ),
    ).resolves.toBe("invalid");
  });
});

describe("readConsoleSecret", () => {
  it("reads the host's environment, and a Worker's from its request", () => {
    expect(readConsoleSecret(request())).toBe(SECRET);

    const worker = Object.assign(request(), {
      runtime: {
        cloudflare: { env: { [CONSOLE_SECRET_ENV]: `${SECRET}-worker` } },
      },
    });
    expect(readConsoleSecret(worker)).toBe(`${SECRET}-worker`);
  });

  it("signs with nothing rather than a missing or short secret", () => {
    for (const value of ["", "   ", "too-short"]) {
      vi.stubEnv(CONSOLE_SECRET_ENV, value);
      expect(readConsoleSecret(request())).toBeUndefined();
    }
  });
});

describe("refuseNativeBuildDownloadToken", () => {
  it("lets a valid token through", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );

    await expect(
      refuseNativeBuildDownloadToken(request(), BUILD, token),
    ).resolves.toBeUndefined();
  });

  it("says what's wrong and the next step, in a 403 that doesn't repeat the token", async () => {
    const expired = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() - 60_000,
    );
    const answers = [
      [expired, "This download link has expired."],
      [`${expired}x`, "This download link isn't valid."],
    ] as const;
    for (const [token, message] of answers) {
      const response = (await refuseNativeBuildDownloadToken(
        request(),
        BUILD,
        token,
      ))!;
      const body = await response.text();

      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain(message);
      expect(body).toContain("Console page");
      expect(body).not.toContain(token);
    }
  });

  it("refuses every token on a Console without the secret, and names it", async () => {
    const token = await createNativeBuildDownloadToken(
      SECRET,
      BUILD,
      Date.now() + 60_000,
    );
    vi.stubEnv(CONSOLE_SECRET_ENV, "");

    const response = (await refuseNativeBuildDownloadToken(
      request(),
      BUILD,
      token,
    ))!;

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(CONSOLE_SECRET_ENV);
  });
});

describe("issueNativeBuildDownloadLink", () => {
  it("issues a token that works for 30 days", async () => {
    expect(NATIVE_BUILD_DOWNLOAD_LINK_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);

    const link = await issueNativeBuildDownloadLink(BUILD, request(), NOW);
    if (link.status !== "issued") throw new Error(link.status);
    const expiresAt = NOW + NATIVE_BUILD_DOWNLOAD_LINK_TTL_MS;

    expect(link.expiresAt).toBe(new Date(expiresAt).toISOString());
    await expect(
      verifyNativeBuildDownloadToken(SECRET, BUILD, link.token, expiresAt - 1),
    ).resolves.toBe("valid");
    await expect(
      verifyNativeBuildDownloadToken(SECRET, BUILD, link.token, expiresAt),
    ).resolves.toBe("expired");
  });

  it("names the secret when the Console has none, and returns no token", async () => {
    vi.stubEnv(CONSOLE_SECRET_ENV, "");

    await expect(
      issueNativeBuildDownloadLink(BUILD, request(), NOW),
    ).resolves.toEqual({
      status: "no-secret",
      secretName: CONSOLE_SECRET_ENV,
    });
  });

  it("issues none on a local console, whose lock would refuse the link", async () => {
    guard.current = () => undefined;

    await expect(
      issueNativeBuildDownloadLink(BUILD, request(), NOW),
    ).resolves.toEqual({ status: "local-console" });
  });
});
