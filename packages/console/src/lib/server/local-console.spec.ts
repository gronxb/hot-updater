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
    for (const path of ["/", "/api-keys", "/_serverFn/createApiKeyRpc"]) {
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
        `http://localhost:1422/insights?range=7d&${LOCAL_CONSOLE_SESSION_PARAM}=${SESSION}`,
      ),
      OPTIONS,
    );

    expect(answer?.status).toBe(303);
    expect(answer?.headers.get("location")).toBe("/insights?range=7d");
    expect(answer?.headers.get("set-cookie")).toBe(
      `${COOKIE}; Path=/; HttpOnly; SameSite=Strict`,
    );
  });

  it("lets the session's cookie through, and nothing like it", () => {
    expect(
      guardLocalConsoleRequest(
        request("http://localhost:1422/api-keys", {
          headers: { cookie: COOKIE },
        }),
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
          request("http://localhost:1422/api-keys", { headers: { cookie } }),
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

  it("serves a console on port 80, whose Host and Origin name no port", () => {
    const options = { ...OPTIONS, port: "80" };
    const cookie = `hot_updater_console_session_80=${SESSION}`;
    for (const host of ["localhost", "localhost:80", "127.0.0.1"]) {
      expect(
        guardLocalConsoleRequest(
          request(`http://${host}/?${LOCAL_CONSOLE_SESSION_PARAM}=${SESSION}`, {
            host,
          }),
          options,
        )?.status,
        host,
      ).toBe(303);
    }
    expect(
      guardLocalConsoleRequest(
        request("http://localhost/_serverFn/revokeApiKeyRpc", {
          host: "localhost",
          method: "POST",
          headers: { origin: "http://localhost", cookie },
        }),
        options,
      ),
    ).toBeUndefined();
    expect(
      guardLocalConsoleRequest(
        request("http://localhost/", { host: "localhost:1422" }),
        options,
      )?.status,
    ).toBe(403);
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
        request("http://localhost:1422/_serverFn/revokeApiKeyRpc", {
          method: "POST",
          headers: { ...headers, cookie: COOKIE },
        }),
        OPTIONS,
      );
      expect(refusal?.status, JSON.stringify(headers)).toBe(403);
    }
    expect(
      guardLocalConsoleRequest(
        request("http://localhost:1422/_serverFn/revokeApiKeyRpc", {
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

  it("asks for the session on the /_hot-updater/ routes too", () => {
    const path =
      "/_hot-updater/native-builds/qr?build=019a0000-0000-7000-8000-00000000b001";
    expect(
      guardLocalConsoleRequest(request(`http://localhost:1422${path}`), OPTIONS)
        ?.status,
    ).toBe(401);
    expect(
      guardLocalConsoleRequest(
        request(`http://localhost:1422${path}`, {
          headers: { cookie: COOKIE },
        }),
        OPTIONS,
      ),
    ).toBeUndefined();
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
