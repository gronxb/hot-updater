import crypto from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log: { info: vi.fn() } },
}));

import type { IssueAscApiKeyRequest } from "../ascApiKey";
import type { AppleSignInPrompts, TwoFactorCodeRequest } from "./appleSignIn";
import { createAscKeyIssuer, twoFactorMessage } from "./ascKeyIssuer";

const AUTH = "https://idmsa.apple.com/appleauth/auth";
const ASC = "https://appstoreconnect.apple.com";
const PASSWORD = "correct horse";
const WIDGET_KEY = "widget-from-signout";

const p8 = crypto
  .generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
  .trim();

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

type Reply = Response | ((request: Recorded) => Response | undefined);

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });

const providers = [
  { providerId: 1, publicProviderId: "team-1", name: "Acme" },
  { providerId: 2, publicProviderId: "team-2", name: "Acme Labs" },
];

/**
 * A stand-in for Apple: each route answers as Apple's sign-in and App Store
 * Connect do, in the shapes asc 5.16.1 reads (internal/web/auth.go,
 * internal/web/api_keys.go). `overrides` replaces a route's answer.
 */
const fakeApple = (overrides: Record<string, Reply> = {}) => {
  const requests: Recorded[] = [];
  let provider = providers[0]!;
  const routes: Record<string, Reply> = {
    [`HEAD ${ASC}/logout`]: new Response(null, {
      status: 302,
      headers: {
        Location: `https://idmsa.apple.com/appleauth/signout?widgetKey=${WIDGET_KEY}`,
      },
    }),
    [`POST ${AUTH}/signin/init`]: json({
      iteration: 1000,
      salt: Buffer.from("salt").toString("base64"),
      protocol: "s2k",
      b: Buffer.from("02", "hex").toString("base64"),
      c: { challenge: "opaque" },
    }),
    [`GET ${AUTH}/signin?widgetKey=${WIDGET_KEY}`]: new Response("<html>", {
      headers: { "X-Apple-HC-Bits": "4", "X-Apple-HC-Challenge": "abc" },
    }),
    [`POST ${AUTH}/signin/complete?isRememberMeEnabled=false`]: new Response(
      null,
      {
        status: 409,
        headers: {
          "X-Apple-ID-Session-Id": "session-1",
          scnt: "scnt-1",
          "Set-Cookie": "aasp=pending; Domain=idmsa.apple.com; Path=/",
        },
      },
    ),
    [`GET ${AUTH}`]: json(
      {
        trustedDevices: [{}],
        trustedPhoneNumbers: [
          { id: 7, numberWithDialCode: "+1 (•••) •••-••12", pushMode: "sms" },
        ],
      },
      { headers: { scnt: "scnt-2" } },
    ),
    [`POST ${AUTH}/verify/trusteddevice/securitycode`]: (request) =>
      JSON.parse(request.body!).securityCode.code === "123456"
        ? new Response(null, { status: 204 })
        : json({ serviceErrors: [{ code: "-21669" }] }, { status: 400 }),
    [`PUT ${AUTH}/verify/phone`]: json({}),
    [`POST ${AUTH}/verify/phone/securitycode`]: (request) =>
      ["654321", "65432100"].includes(
        JSON.parse(request.body!).securityCode.code,
      )
        ? json({})
        : json({}, { status: 400 }),
    [`GET ${AUTH}/2sv/trust`]: new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": "myacinfo=signed-in; Domain=.apple.com; Path=/; Secure",
      },
    }),
    [`GET ${ASC}/olympus/v1/session`]: () =>
      json({
        provider,
        availableProviders: providers,
        user: { emailAddress: "dev@example.com" },
      }),
    [`POST ${ASC}/olympus/v1/session`]: (request) => {
      const id = JSON.parse(request.body!).provider.providerId;
      provider = providers.find((value) => value.providerId === id)!;
      return json({});
    },
    [`POST ${ASC}/iris/v1/apiKeys`]: json(
      {
        data: {
          type: "apiKeys",
          id: "KEY1234567",
          attributes: { nickname: "hot-updater 2026-10-28", isActive: true },
        },
      },
      { status: 201 },
    ),
    [`GET ${ASC}/iris/v1/apiKeys/KEY1234567?fields%5BapiKeys%5D=privateKey`]:
      json({
        data: {
          type: "apiKeys",
          id: "KEY1234567",
          attributes: { privateKey: Buffer.from(p8).toString("base64") },
        },
      }),
    [`GET ${ASC}/iris/v1/apiKeys/KEY1234567?include=provider`]: json({
      data: {
        type: "apiKeys",
        id: "KEY1234567",
        relationships: { provider: { data: { id: "issuer-1" } } },
      },
    }),
    [`PATCH ${ASC}/iris/v1/apiKeys/KEY1234567`]: json({
      data: { id: "KEY1234567", attributes: { isActive: false } },
    }),
    ...overrides,
  };
  const fetch = vi.fn(
    async (input: URL | string | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const recorded: Recorded = {
        method,
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      requests.push(recorded);
      expect(init?.redirect).toBe("manual");
      const reply = routes[`${method} ${url}`];
      const response =
        typeof reply === "function" ? reply(recorded) : reply?.clone();
      if (!response) throw new Error(`Unexpected request ${method} ${url}`);
      return response;
    },
  );
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    calls: () => requests.map((request) => `${request.method} ${request.url}`),
  };
};

const prompts = (codes: (string | undefined)[] = ["123456"]) => {
  const asked: TwoFactorCodeRequest[] = [];
  const value: AppleSignInPrompts = {
    password: vi.fn(async () => PASSWORD),
    twoFactorCode: vi.fn(async (request) => {
      asked.push(request);
      return codes.shift();
    }),
  };
  return { prompts: value, asked };
};

const request: IssueAscApiKeyRequest = {
  name: "hot-updater 2026-10-28",
  role: "ADMIN",
  appleId: "dev@example.com",
};

const wait = vi.fn(async () => {});

const DEVICE = {
  via: "device",
  destination: "+1 (•••) •••-••12",
  textsOnWrongCode: true,
  afterWrongCode: false,
  length: 6,
};
const TEXTED = {
  via: "sms",
  destination: "+1 (•••) •••-••12",
  textsOnWrongCode: false,
  afterWrongCode: true,
  length: 6,
};

beforeEach(() => {
  wait.mockClear();
});

describe("createAscKeyIssuer", () => {
  it("signs in with a device code and creates a team key of the role asked for", async () => {
    const apple = fakeApple();
    const sign = prompts();
    const key = await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: sign.prompts,
      wait,
    })(request);

    expect(key).toMatchObject({
      p8,
      keyId: "KEY1234567",
      issuerId: "issuer-1",
      name: "hot-updater 2026-10-28",
      team: { appleId: "dev@example.com", teamId: "team-1", name: "Acme" },
    });
    expect(apple.calls()).toEqual([
      `HEAD ${ASC}/logout`,
      `POST ${AUTH}/signin/init`,
      `GET ${AUTH}/signin?widgetKey=${WIDGET_KEY}`,
      `POST ${AUTH}/signin/complete?isRememberMeEnabled=false`,
      `GET ${AUTH}`,
      `POST ${AUTH}/verify/trusteddevice/securitycode`,
      `GET ${AUTH}/2sv/trust`,
      `GET ${ASC}/olympus/v1/session`,
      `POST ${ASC}/iris/v1/apiKeys`,
      `GET ${ASC}/iris/v1/apiKeys/KEY1234567?fields%5BapiKeys%5D=privateKey`,
      `GET ${ASC}/iris/v1/apiKeys/KEY1234567?include=provider`,
    ]);
    expect(sign.asked).toEqual([DEVICE]);
    const create = apple.requests.find(
      (value) => value.url === `${ASC}/iris/v1/apiKeys`,
    )!;
    expect(JSON.parse(create.body!)).toEqual({
      data: {
        type: "apiKeys",
        attributes: {
          nickname: "hot-updater 2026-10-28",
          roles: ["ADMIN"],
          allAppsVisible: true,
          keyType: "PUBLIC_API",
        },
      },
    });
    expect(create.headers).toMatchObject({
      "x-csrf-itc": "[asc-ui]",
      referer: `${ASC}/access/integrations/api`,
      cookie: "myacinfo=signed-in",
    });
  });

  it("sends Apple an SRP proof and a hashcash, and the password nowhere", async () => {
    const apple = fakeApple();
    await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })(request);

    const init = apple.requests[1]!;
    expect(JSON.parse(init.body!)).toMatchObject({
      accountName: "dev@example.com",
      protocols: ["s2k", "s2k_fo"],
    });
    expect(init.headers["x-apple-widget-key"]).toBe(WIDGET_KEY);
    const complete = apple.requests[3]!;
    const body = JSON.parse(complete.body!);
    expect(body).toMatchObject({
      accountName: "dev@example.com",
      rememberMe: false,
      c: { challenge: "opaque" },
    });
    expect(Buffer.from(body.m1, "base64")).toHaveLength(32);
    const stamp = complete.headers["x-apple-hc"]!;
    expect(stamp).toMatch(/^1:4:\d{14}:abc::\d+$/u);
    expect(crypto.createHash("sha1").update(stamp).digest()[0]! & 0xf0).toBe(0);
    for (const sent of apple.requests) {
      expect(JSON.stringify(sent)).not.toContain(PASSWORD);
    }
  });

  it("sends the two-factor session headers Apple last answered", async () => {
    const apple = fakeApple();
    await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })(request);

    const options = apple.requests[4]!;
    expect(options.headers).toMatchObject({
      "x-apple-id-session-id": "session-1",
      scnt: "scnt-1",
      "x-apple-widget-key": WIDGET_KEY,
      cookie: "aasp=pending",
    });
    // The options answered a new scnt; the code goes with it.
    expect(apple.requests[5]!.headers.scnt).toBe("scnt-2");
    // A cookie for idmsa.apple.com stays there.
    expect(apple.requests[7]!.headers.cookie).toBe("myacinfo=signed-in");
  });

  it("keeps cookies as a browser does: host-only ones on their host, expired ones dropped", async () => {
    const apple = fakeApple({
      [`GET ${AUTH}/2sv/trust`]: new Response(null, {
        status: 204,
        headers: [
          ["Set-Cookie", "myacinfo=signed-in; Domain=.apple.com; Path=/"],
          ["Set-Cookie", "dslang=US; Domain=.apple.com; Path=/"],
          ["Set-Cookie", "idmsaonly=1; Path=/"],
          ["Set-Cookie", "elsewhere=1; Domain=example.com; Path=/"],
        ],
      }),
      [`GET ${ASC}/olympus/v1/session`]: json(
        { provider: providers[0], availableProviders: providers },
        {
          headers: {
            "Set-Cookie": "dslang=; Domain=.apple.com; Path=/; Max-Age=0",
          },
        },
      ),
    });
    await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })(request);
    const session = apple.requests.find(
      (value) => value.url === `${ASC}/olympus/v1/session`,
    )!;
    expect(session.headers.cookie).toBe("myacinfo=signed-in; dslang=US");
    const create = apple.requests.find(
      (value) => value.url === `${ASC}/iris/v1/apiKeys`,
    )!;
    expect(create.headers.cookie).toBe("myacinfo=signed-in");
  });

  it("texts a code to the trusted phone after a wrong device code, as Apple's page does", async () => {
    const apple = fakeApple();
    const sign = prompts(["000000", "654321"]);
    await createAscKeyIssuer({ fetch: apple.fetch, prompts: sign.prompts })(
      request,
    );
    expect(sign.asked).toEqual([DEVICE, TEXTED]);
    const texted = apple.requests.find((value) => value.method === "PUT")!;
    expect(JSON.parse(texted.body!)).toEqual({
      phoneNumber: { id: 7 },
      mode: "sms",
    });
    const verified = apple.requests.find(
      (value) => value.url === `${AUTH}/verify/phone/securitycode`,
    )!;
    expect(JSON.parse(verified.body!)).toEqual({
      securityCode: { code: "654321" },
      phoneNumber: { id: 7 },
      mode: "sms",
    });
  });

  it("stops when the texted code is wrong too, and creates nothing", async () => {
    const apple = fakeApple();
    await expect(
      createAscKeyIssuer({
        fetch: apple.fetch,
        prompts: prompts(["000000", "111111"]).prompts,
      })(request),
    ).rejects.toThrow("Apple rejected the verification code.");
    expect(apple.calls()).not.toContain(`POST ${ASC}/iris/v1/apiKeys`);
  });

  it("stops after a wrong device code when no phone is trusted", async () => {
    const apple = fakeApple({
      [`GET ${AUTH}`]: json({ trustedDevices: [{}] }),
    });
    const sign = prompts(["000000"]);
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: sign.prompts })(
        request,
      ),
    ).rejects.toThrow("Apple rejected the verification code.");
    expect(sign.asked).toEqual([
      {
        via: "device",
        destination: undefined,
        textsOnWrongCode: false,
        afterWrongCode: false,
        length: 6,
      },
    ]);
  });

  it("texts a code at once to an Apple Account without trusted devices", async () => {
    const apple = fakeApple({
      [`GET ${AUTH}`]: json({
        noTrustedDevices: true,
        trustedPhoneNumbers: [
          { id: 7, numberWithDialCode: "+82 ••-••••-••34" },
        ],
        securityCode: { length: 8 },
      }),
    });
    const sign = prompts(["65432100"]);
    await createAscKeyIssuer({ fetch: apple.fetch, prompts: sign.prompts })(
      request,
    );
    expect(sign.asked).toEqual([
      {
        via: "sms",
        destination: "+82 ••-••••-••34",
        textsOnWrongCode: false,
        afterWrongCode: false,
        length: 8,
      },
    ]);
    expect(apple.calls()).toContain(`PUT ${AUTH}/verify/phone`);
    expect(apple.calls()).not.toContain(
      `POST ${AUTH}/verify/trusteddevice/securitycode`,
    );
  });

  it("signs in without a code when Apple asks for none", async () => {
    const apple = fakeApple({
      [`POST ${AUTH}/signin/complete?isRememberMeEnabled=false`]: new Response(
        "{}",
        {
          headers: {
            "Set-Cookie": "myacinfo=signed-in; Domain=.apple.com; Path=/",
          },
        },
      ),
    });
    const sign = prompts();
    await createAscKeyIssuer({ fetch: apple.fetch, prompts: sign.prompts })(
      request,
    );
    expect(sign.prompts.twoFactorCode).not.toHaveBeenCalled();
    expect(apple.calls()).not.toContain(`GET ${AUTH}`);
  });

  it("reports a wrong password", async () => {
    const apple = fakeApple({
      [`POST ${AUTH}/signin/complete?isRememberMeEnabled=false`]: json(
        { serviceErrors: [{ code: "-20101", message: "Check the account." }] },
        { status: 401 },
      ),
    });
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })(
        request,
      ),
    ).rejects.toThrow("Apple rejected the email or password.");
  });

  it("names a pending Apple Account prompt", async () => {
    const apple = fakeApple({
      [`POST ${AUTH}/signin/complete?isRememberMeEnabled=false`]: json(
        { authType: "hsa2" },
        { status: 412 },
      ),
    });
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })(
        request,
      ),
    ).rejects.toThrow(
      "The Apple Account has a pending prompt. Sign in at https://appstoreconnect.apple.com once, then run this again.",
    );
  });

  it("passes Apple's own message through for another sign-in failure", async () => {
    const apple = fakeApple({
      [`POST ${AUTH}/signin/init`]: json(
        {
          serviceErrors: [
            { code: "-20209", message: "This account is locked." },
          ],
        },
        { status: 403 },
      ),
    });
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })(
        request,
      ),
    ).rejects.toThrow(
      "Starting the sign-in failed (HTTP 403).\nThis account is locked.",
    );
  });

  it("sends nothing when the password prompt is cancelled", async () => {
    const apple = fakeApple();
    const sign = prompts();
    vi.mocked(sign.prompts.password).mockResolvedValueOnce(undefined);
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: sign.prompts })(
        request,
      ),
    ).rejects.toThrow("Signing in was cancelled.");
    expect(apple.requests).toEqual([]);
  });

  it("creates nothing when the code prompt is cancelled", async () => {
    const apple = fakeApple();
    await expect(
      createAscKeyIssuer({
        fetch: apple.fetch,
        prompts: prompts([undefined]).prompts,
      })(request),
    ).rejects.toThrow("Signing in was cancelled.");
    expect(apple.calls().at(-1)).toBe(`GET ${AUTH}`);
  });

  it("creates the key in the team chooseTeam picks", async () => {
    const apple = fakeApple();
    const chooseTeam = vi.fn(async () => "team-2");
    const key = await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })({ ...request, chooseTeam });

    expect(chooseTeam).toHaveBeenCalledWith(
      [
        { appleId: "dev@example.com", teamId: "team-1", name: "Acme" },
        { appleId: "dev@example.com", teamId: "team-2", name: "Acme Labs" },
      ],
      { appleId: "dev@example.com", teamId: "team-1", name: "Acme" },
    );
    const switched = apple.requests.find(
      (value) => value.method === "POST" && value.url.endsWith("/session"),
    )!;
    expect(JSON.parse(switched.body!)).toEqual({ provider: { providerId: 2 } });
    expect(
      apple.calls().indexOf(`POST ${ASC}/olympus/v1/session`),
    ).toBeLessThan(apple.calls().indexOf(`POST ${ASC}/iris/v1/apiKeys`));
    expect(key.team).toEqual({
      appleId: "dev@example.com",
      teamId: "team-2",
      name: "Acme Labs",
    });
  });

  it("creates the key in teamId without asking", async () => {
    const apple = fakeApple();
    const chooseTeam = vi.fn(async () => undefined);
    const key = await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })({ ...request, teamId: "team-2", chooseTeam });
    expect(chooseTeam).not.toHaveBeenCalled();
    expect(key.team.teamId).toBe("team-2");
  });

  it("refuses a team the Apple Account is not in, and creates nothing", async () => {
    const apple = fakeApple();
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })({
        ...request,
        teamId: "team-9",
      }),
    ).rejects.toThrow("The Apple Account is in no team team-9.");
    expect(apple.calls()).not.toContain(`POST ${ASC}/iris/v1/apiKeys`);
  });

  it("revokes the key in the session it was issued in, until dispose", async () => {
    const apple = fakeApple();
    const key = await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })(request);

    await expect(key.revoke()).resolves.toBe(true);
    const revoked = apple.requests.at(-1)!;
    expect(revoked).toMatchObject({
      method: "PATCH",
      url: `${ASC}/iris/v1/apiKeys/KEY1234567`,
      headers: { cookie: "myacinfo=signed-in" },
    });
    expect(JSON.parse(revoked.body!)).toEqual({
      data: {
        id: "KEY1234567",
        type: "apiKeys",
        attributes: { isActive: false },
      },
    });

    await key.dispose();
    const sent = apple.requests.length;
    await expect(key.revoke()).resolves.toBe(false);
    expect(apple.requests).toHaveLength(sent);
  });

  it("answers false when the revoke fails", async () => {
    const apple = fakeApple({
      [`PATCH ${ASC}/iris/v1/apiKeys/KEY1234567`]: json({}, { status: 500 }),
    });
    const key = await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })(request);
    await expect(key.revoke()).resolves.toBe(false);
  });

  it("retries a .p8 App Store Connect hasn't settled yet", async () => {
    let downloads = 0;
    const apple = fakeApple({
      [`GET ${ASC}/iris/v1/apiKeys/KEY1234567?fields%5BapiKeys%5D=privateKey`]:
        () =>
          ++downloads === 1
            ? json({}, { status: 404 })
            : json({
                data: {
                  id: "KEY1234567",
                  attributes: {
                    privateKey: Buffer.from(p8).toString("base64"),
                  },
                },
              }),
    });
    const key = await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
      wait,
    })(request);
    expect(key.p8).toBe(p8);
    expect(wait).toHaveBeenCalledWith(1000);
  });

  it("revokes a key whose .p8 is not a P-256 private key", async () => {
    const rsa = crypto
      .generateKeyPairSync("rsa", { modulusLength: 1024 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const apple = fakeApple({
      [`GET ${ASC}/iris/v1/apiKeys/KEY1234567?fields%5BapiKeys%5D=privateKey`]:
        json({
          data: {
            id: "KEY1234567",
            attributes: { privateKey: Buffer.from(rsa).toString("base64") },
          },
        }),
    });
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })(
        request,
      ),
    ).rejects.toThrow(
      "App Store Connect sent a .p8 that is not a P-256 private key. The App Store Connect API key KEY1234567 was revoked again.",
    );
    expect(apple.calls().at(-1)).toBe(
      `PATCH ${ASC}/iris/v1/apiKeys/KEY1234567`,
    );
  });

  it("names the key to revoke by hand when the revoke of an unusable key fails", async () => {
    const apple = fakeApple({
      [`GET ${ASC}/iris/v1/apiKeys/KEY1234567?include=provider`]: json({
        data: { id: "KEY1234567" },
      }),
      [`PATCH ${ASC}/iris/v1/apiKeys/KEY1234567`]: json({}, { status: 500 }),
    });
    await expect(
      createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })(
        request,
      ),
    ).rejects.toThrow(
      "App Store Connect named no issuer ID for the key. Revoking the App Store Connect API key KEY1234567 failed too: revoke it at https://appstoreconnect.apple.com/access/integrations/api.",
    );
  });

  it.each([
    [
      403,
      {
        errors: [{ detail: "You are not allowed to perform this operation." }],
      },
      "Creating an API key needs the Account Holder or Admin role in the team.",
    ],
    [
      409,
      {
        errors: [{ detail: "The Program License Agreement has been updated." }],
      },
      "The Account Holder must accept the new Apple Developer Program License\nAgreement",
    ],
    [
      409,
      { errors: [{ detail: "You have reached the maximum number of keys." }] },
      "The team has the most API keys App Store Connect allows.",
    ],
  ])(
    "says what to do when App Store Connect answers %i to the create",
    async (status, body, hint) => {
      const apple = fakeApple({
        [`POST ${ASC}/iris/v1/apiKeys`]: json(body, { status }),
      });
      await expect(
        createAscKeyIssuer({ fetch: apple.fetch, prompts: prompts().prompts })(
          request,
        ),
      ).rejects.toThrow(
        `Creating the App Store Connect API key failed (HTTP ${status}).\n${body.errors[0]!.detail}\n${hint}`,
      );
    },
  );
});

describe("the widget key", () => {
  const signIn = async (overrides: Record<string, Reply>) => {
    const apple = fakeApple({
      ...overrides,
      [`POST ${AUTH}/signin/complete?isRememberMeEnabled=false`]: new Response(
        "{}",
      ),
    });
    await createAscKeyIssuer({
      fetch: apple.fetch,
      prompts: prompts().prompts,
    })(request);
    return apple;
  };

  it("is read from App Store Connect's config when the sign-out redirect names none", async () => {
    const apple = await signIn({
      [`HEAD ${ASC}/logout`]: new Response(null, { status: 200 }),
      [`GET ${ASC}/olympus/v1/app/config?hostname=itunesconnect.apple.com`]:
        json({ authServiceKey: "widget-from-config" }),
      [`GET ${AUTH}/signin?widgetKey=widget-from-config`]: new Response(""),
    });
    expect(apple.requests[2]!.headers["x-apple-widget-key"]).toBe(
      "widget-from-config",
    );
  });

  it("is the one App Store Connect's page ships when its config is gone", async () => {
    const shipped =
      "e0b80c3bf78523bfe80974d320935bfa30add02e1bff88ec2166c6bd5a706c42";
    const apple = await signIn({
      [`HEAD ${ASC}/logout`]: new Response(null, { status: 200 }),
      [`GET ${ASC}/olympus/v1/app/config?hostname=itunesconnect.apple.com`]:
        new Response("", { status: 404 }),
      [`GET ${AUTH}/signin?widgetKey=${shipped}`]: new Response(""),
    });
    expect(apple.requests[2]!.headers["x-apple-widget-key"]).toBe(shipped);
  });

  it("asks the sign-out redirect without the session's cookies", async () => {
    const apple = await signIn({});
    expect(apple.requests[0]!.headers.cookie).toBeUndefined();
  });
});

describe("twoFactorMessage", () => {
  const base = {
    destination: "+1 (•••) •••-••12",
    afterWrongCode: false,
    length: 6,
  };

  it("says where a device code is shown, and where a wrong one texts the next", () => {
    expect(
      twoFactorMessage({ ...base, via: "device", textsOnWrongCode: true }),
    ).toBe(
      "Code shown on your Apple device (no device? enter a wrong code to text +1 (•••) •••-••12)",
    );
    expect(
      twoFactorMessage({ ...base, via: "device", textsOnWrongCode: false }),
    ).toBe("Code shown on your Apple device");
  });

  it("names the number a code was texted to", () => {
    expect(
      twoFactorMessage({ ...base, via: "sms", textsOnWrongCode: false }),
    ).toBe("Code texted to +1 (•••) •••-••12");
    expect(
      twoFactorMessage({
        ...base,
        via: "sms",
        textsOnWrongCode: false,
        afterWrongCode: true,
        destination: undefined,
      }),
    ).toBe("Wrong code. Code texted to your trusted phone");
  });
});
