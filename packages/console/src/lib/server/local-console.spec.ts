// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  guardLocalConsoleRequest,
  LOCAL_CONSOLE_SESSION_PARAM,
} from "./local-console";

const SESSION = "run-session_0123456789abcdefghijklmnopqrstuv";
const OPTIONS = { session: SESSION, port: "1422", checkHost: true };
const COOKIE = `hot_updater_console_session_1422=${SESSION}`;

const request = (
  url: string,
  {
    host = "localhost:1422",
    ...init
  }: RequestInit & { readonly host?: string | null } = {},
) => {
  const headers = new Headers(init.headers);
  if (host !== null) headers.set("host", host);
  return new Request(url, { ...init, headers });
};

describe("guardLocalConsoleRequest", () => {
  it("refuses every page and server function without the run's session", async () => {
    for (const path of ["/", "/vault", "/_serverFn/issueVaultTokenRpc"]) {
      const refusal = guardLocalConsoleRequest(
        request(`http://localhost:1422${path}`),
        OPTIONS,
      );
      expect(refusal?.status, path).toBe(401);
      await expect(refusal!.text()).resolves.toBe(
        "Open this console with the link hot-updater console printed.",
      );
    }
    expect(
      guardLocalConsoleRequest(request("http://localhost:1422/"), {
        ...OPTIONS,
        session: undefined,
      })?.status,
    ).toBe(401);
  });

  it("trades the link's session for an HttpOnly, SameSite=Strict cookie, and drops it from the address", () => {
    const answer = guardLocalConsoleRequest(
      request(
        `http://localhost:1422/vault?tab=tokens&${LOCAL_CONSOLE_SESSION_PARAM}=${SESSION}`,
      ),
      OPTIONS,
    );

    expect(answer?.status).toBe(303);
    expect(answer?.headers.get("location")).toBe("/vault?tab=tokens");
    expect(answer?.headers.get("set-cookie")).toBe(
      `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
    );
  });

  it("lets the session's cookie through, and nothing like it", () => {
    expect(
      guardLocalConsoleRequest(
        request("http://localhost:1422/vault", { headers: { cookie: COOKIE } }),
        OPTIONS,
      ),
    ).toBeUndefined();
    for (const cookie of [
      `hot_updater_console_session_1422=${SESSION.slice(0, -1)}x`,
      `hot_updater_console_session_1423=${SESSION}`,
      `hot_updater_console_session=${SESSION}`,
    ]) {
      expect(
        guardLocalConsoleRequest(
          request("http://localhost:1422/vault", { headers: { cookie } }),
          OPTIONS,
        )?.status,
        cookie,
      ).toBe(401);
    }
    expect(
      guardLocalConsoleRequest(
        request(
          `http://localhost:1422/?${LOCAL_CONSOLE_SESSION_PARAM}=not-the-session`,
        ),
        OPTIONS,
      )?.status,
    ).toBe(401);
  });

  it("refuses a Host other than this machine on the console's port, as a rebound name sends", () => {
    for (const host of [
      "evil.example:1422",
      "localhost.evil.example:1422",
      "127.0.0.1.nip.io:1422",
      "localhost:1423",
      "localhost",
      "192.168.0.2:1422",
      null,
    ]) {
      const refusal = guardLocalConsoleRequest(
        request("http://localhost:1422/", {
          host,
          headers: { cookie: COOKIE },
        }),
        OPTIONS,
      );
      expect(refusal?.status, String(host)).toBe(403);
    }
    for (const host of ["localhost:1422", "127.0.0.1:1422", "[::1]:1422"]) {
      expect(
        guardLocalConsoleRequest(
          request(`http://${host}/`, { host, headers: { cookie: COOKIE } }),
          OPTIONS,
        ),
        host,
      ).toBeUndefined();
    }
  });

  it("refuses a change another origin sends, even with the session's cookie", () => {
    const crossOrigin: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "http://127.0.0.1:1422" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of crossOrigin) {
      const refusal = guardLocalConsoleRequest(
        request("http://localhost:1422/_serverFn/rewrapVaultRpc", {
          method: "POST",
          headers: { ...headers, cookie: COOKIE },
        }),
        OPTIONS,
      );
      expect(refusal?.status, JSON.stringify(headers)).toBe(403);
    }
    expect(
      guardLocalConsoleRequest(
        request("http://localhost:1422/_serverFn/rewrapVaultRpc", {
          method: "POST",
          headers: {
            origin: "http://localhost:1422",
            "sec-fetch-site": "same-origin",
            cookie: COOKIE,
          },
        }),
        OPTIONS,
      ),
    ).toBeUndefined();
  });

  it("lets the /_hot-updater/ routes through without the session, as they check the vault token, but not from another host", () => {
    for (const path of [
      "/_hot-updater/vault/v1/secrets",
      "/_hot-updater/signing",
    ]) {
      expect(
        guardLocalConsoleRequest(
          request(`http://127.0.0.1:1422${path}`, { host: "127.0.0.1:1422" }),
          { ...OPTIONS, session: undefined },
        ),
        path,
      ).toBeUndefined();
      expect(
        guardLocalConsoleRequest(
          request(`http://127.0.0.1:1422${path}`, {
            host: "evil.example:1422",
          }),
          OPTIONS,
        )?.status,
      ).toBe(403);
    }
  });

  it("leaves the Host to Vite's dev server, which checks it itself", () => {
    expect(
      guardLocalConsoleRequest(
        request("http://dev.example:3000/", {
          host: "dev.example:3000",
          headers: { cookie: `hot_updater_console_session=${SESSION}` },
        }),
        { session: SESSION, port: undefined, checkHost: false },
      ),
    ).toBeUndefined();
  });
});
