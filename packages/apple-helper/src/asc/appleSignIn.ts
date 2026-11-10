import { createSrpClient, makeHashcash } from "./appleSrp";

/**
 * Signing in to App Store Connect with an Apple Account, as its web page
 * does: Apple's SRP sign-in at idmsa.apple.com, its two-factor check, then
 * App Store Connect's session. The endpoints and their headers follow asc,
 * the open-source App Store Connect CLI
 * (https://github.com/rorkai/App-Store-Connect-CLI, MIT), 5.16.1, whose
 * internal/web/auth.go has signed in this way against Apple.
 */

const AUTH_URL = "https://idmsa.apple.com/appleauth/auth";
const ASC_URL = "https://appstoreconnect.apple.com";
const SESSION_URL = `${ASC_URL}/olympus/v1/session`;

/**
 * The public widget key App Store Connect's sign-in page ships, used when
 * neither place Apple publishes the current one answers. Not a credential.
 */
const ASC_WIDGET_KEY =
  "e0b80c3bf78523bfe80974d320935bfa30add02e1bff88ec2166c6bd5a706c42";

/** Signing in, or a request in the signed-in session, failed. */
export class AppleSignInError extends Error {
  readonly status: number | undefined;
  /** The response body, for messages that depend on what Apple said. */
  readonly body: string | undefined;
  constructor(
    message: string,
    options?: { status?: number; body?: string; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppleSignInError";
    this.status = options?.status;
    this.body = options?.body;
  }
}

/** Where the code a two-factor prompt asks for went. */
export interface TwoFactorCodeRequest {
  /** On the Apple Account's trusted devices, or texted to `destination`. */
  readonly via: "device" | "sms";
  /** The trusted phone number, masked as Apple shows it. */
  readonly destination: string | undefined;
  /** For `device`: whether a wrong code makes Apple text one there instead. */
  readonly textsOnWrongCode: boolean;
  /** Whether the code before this one was rejected. */
  readonly afterWrongCode: boolean;
  /** How many digits the code has. */
  readonly length: number;
}

/**
 * The prompts the Apple Account's password and two-factor codes are typed
 * into. Each answers `undefined` when the developer cancels.
 */
export interface AppleSignInPrompts {
  password(appleId: string | undefined): Promise<string | undefined>;
  twoFactorCode(request: TwoFactorCodeRequest): Promise<string | undefined>;
}

/** An App Store Connect team (provider) the Apple Account belongs to. */
export interface AppleProvider {
  /** The numeric ID App Store Connect switches teams with. */
  readonly providerId: number;
  /** The team's ID, the issuer ID of its API keys. */
  readonly publicProviderId: string;
  readonly name: string | undefined;
}

/** A signed-in App Store Connect session, held only in memory. */
export interface AppleWebSession {
  readonly appleId: string;
  /** The team the session is in. */
  readonly provider: AppleProvider;
  /** Every team the Apple Account can switch to. */
  readonly providers: readonly AppleProvider[];
  /** Switches the session to the team `publicProviderId` names. */
  selectProvider(publicProviderId: string): Promise<AppleProvider>;
  /** A request with the session's cookies. */
  request(url: string, init?: AppleRequestInit): Promise<Response>;
  /** Forgets the session's cookies; the session can't be used after. */
  clear(): void;
}

export interface AppleRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface StoredCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly path: string;
  readonly expires: number | undefined;
}

/**
 * A cookie jar for the sign-in's requests, as a browser keeps one: `fetch`
 * keeps none, and Apple's session is its cookies.
 */
const createCookieJar = () => {
  let cookies: StoredCookie[] = [];
  const live = () => {
    const now = Date.now();
    cookies = cookies.filter(
      (cookie) => cookie.expires === undefined || cookie.expires > now,
    );
    return cookies;
  };
  return {
    store(url: URL, response: Response) {
      for (const header of response.headers.getSetCookie()) {
        const [pair = "", ...attributes] = header.split(";");
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        let domain = url.hostname;
        let hostOnly = true;
        let path = "/";
        let expires: number | undefined;
        let maxAge: number | undefined;
        for (const attribute of attributes) {
          const index = attribute.indexOf("=");
          const key = (index === -1 ? attribute : attribute.slice(0, index))
            .trim()
            .toLowerCase();
          const raw = index === -1 ? "" : attribute.slice(index + 1).trim();
          if (key === "domain" && raw) {
            const candidate = raw.replace(/^\./u, "").toLowerCase();
            // A cookie for another site is ignored, as a browser does.
            if (
              url.hostname !== candidate &&
              !url.hostname.endsWith(`.${candidate}`)
            ) {
              domain = "";
              break;
            }
            domain = candidate;
            hostOnly = false;
          } else if (key === "path" && raw.startsWith("/")) {
            path = raw;
          } else if (key === "expires") {
            const time = Date.parse(raw);
            if (!Number.isNaN(time)) expires = time;
          } else if (key === "max-age" && /^-?\d+$/u.test(raw)) {
            maxAge = Number(raw);
          }
        }
        if (!domain) continue;
        if (maxAge !== undefined) expires = Date.now() + maxAge * 1000;
        cookies = cookies.filter(
          (cookie) =>
            !(
              cookie.name === name &&
              cookie.domain === domain &&
              cookie.path === path
            ),
        );
        if (expires === undefined || expires > Date.now()) {
          cookies.push({ name, value, domain, hostOnly, path, expires });
        }
      }
    },
    header(url: URL) {
      const matching = live().filter(
        (cookie) =>
          (cookie.hostOnly
            ? url.hostname === cookie.domain
            : url.hostname === cookie.domain ||
              url.hostname.endsWith(`.${cookie.domain}`)) &&
          (url.pathname === cookie.path ||
            url.pathname.startsWith(
              cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
            )),
      );
      return matching.length === 0
        ? undefined
        : matching.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    },
    clear() {
      cookies = [];
    },
  };
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** `fetch` with the jar's cookies, following redirects itself to keep them. */
const createClient = (fetch: typeof globalThis.fetch) => {
  const jar = createCookieJar();
  const request = async (
    url: string,
    init: AppleRequestInit = {},
  ): Promise<Response> => {
    let current = new URL(url);
    let method = init.method ?? "GET";
    let body = init.body;
    for (let hop = 0; hop < 10; hop++) {
      const headers = new Headers(init.headers);
      const cookie = jar.header(current);
      if (cookie) headers.set("Cookie", cookie);
      const response = await fetch(current, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
      });
      jar.store(current, response);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || !location) return response;
      await response.text();
      current = new URL(location, current);
      if (
        response.status === 303 ||
        (response.status !== 307 &&
          response.status !== 308 &&
          method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
    }
    throw new AppleSignInError(`${url} redirected too many times.`);
  };
  return { request, clear: jar.clear };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** What Apple's sign-in said went wrong, from its `serviceErrors`. */
const serviceErrors = (body: string) => {
  const parsed = parseJson(body);
  const errors =
    isRecord(parsed) && Array.isArray(parsed.serviceErrors)
      ? parsed.serviceErrors.filter(isRecord)
      : [];
  return {
    codes: errors.map((error) => text(error.code)).filter(Boolean),
    message: errors.map((error) => text(error.message)).find(Boolean),
  };
};

const failure = (step: string, response: Response, body: string) =>
  new AppleSignInError(
    `${step} failed (HTTP ${response.status}).${serviceErrors(body).message ? `\n${serviceErrors(body).message}` : ""}`,
    { status: response.status, body },
  );

type Client = ReturnType<typeof createClient>;

/**
 * The widget key Apple's sign-in wants: from the sign-out redirect App Store
 * Connect answers without cookies, else its config, else the one its page
 * ships.
 */
const findWidgetKey = async (
  fetch: typeof globalThis.fetch,
  client: Client,
) => {
  const signOut = await fetch(`${ASC_URL}/logout`, {
    method: "HEAD",
    redirect: "manual",
  }).catch(() => undefined);
  const location = signOut?.headers.get("location");
  if (signOut && REDIRECTS.has(signOut.status) && location) {
    const url = (() => {
      try {
        return new URL(location);
      } catch {
        return undefined;
      }
    })();
    const keys = url?.searchParams.getAll("widgetKey") ?? [];
    if (
      url?.protocol === "https:" &&
      url.hostname === "idmsa.apple.com" &&
      url.pathname === "/appleauth/signout" &&
      keys.length === 1 &&
      keys[0]!.trim()
    ) {
      return keys[0]!.trim();
    }
  }
  const config = await client.request(
    `${ASC_URL}/olympus/v1/app/config?hostname=itunesconnect.apple.com`,
  );
  const body = await config.text();
  if (config.status === 404) return ASC_WIDGET_KEY;
  const parsed = parseJson(body);
  const key = isRecord(parsed)
    ? (text(parsed.authServiceKey) ?? text(parsed.serviceKey))
    : undefined;
  if (!config.ok || !key) {
    throw new AppleSignInError(
      `Couldn't load Apple's sign-in configuration (HTTP ${config.status}).`,
      { status: config.status },
    );
  }
  return key;
};

const hashcash = async (client: Client, widgetKey: string) => {
  const response = await client.request(
    `${AUTH_URL}/signin?widgetKey=${encodeURIComponent(widgetKey)}`,
    {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    },
  );
  await response.text();
  if (!response.ok) {
    throw new AppleSignInError(
      `Loading Apple's sign-in page failed (HTTP ${response.status}).`,
      { status: response.status },
    );
  }
  const bits = response.headers.get("x-apple-hc-bits")?.trim();
  const challenge = response.headers.get("x-apple-hc-challenge")?.trim();
  if (!bits || !challenge) return undefined;
  if (!/^\d+$/u.test(bits) || Number(bits) > 32) {
    throw new AppleSignInError(`Apple asked for a hashcash of ${bits} bits.`);
  }
  return makeHashcash(Number(bits), challenge);
};

/** The idmsa headers of a sign-in waiting for its two-factor code. */
interface PendingSignIn {
  widgetKey: string;
  sessionId: string;
  scnt: string;
}

const pendingHeaders = (pending: PendingSignIn) => ({
  "X-Apple-ID-Session-Id": pending.sessionId,
  "X-Apple-Widget-Key": pending.widgetKey,
  scnt: pending.scnt,
  Accept: "application/json",
});

/** Apple rotates `scnt` and the session ID; each request sends the latest. */
const track = (pending: PendingSignIn, response: Response) => {
  const scnt = response.headers.get("scnt")?.trim();
  const sessionId = response.headers.get("x-apple-id-session-id")?.trim();
  if (scnt) pending.scnt = scnt;
  if (sessionId) pending.sessionId = sessionId;
};

const CANCELLED = "Signing in was cancelled.";

const twoFactor = async (
  client: Client,
  pending: PendingSignIn,
  prompts: AppleSignInPrompts,
) => {
  const send = async (url: string, method: string, payload?: unknown) => {
    const response = await client.request(url, {
      method,
      headers: {
        ...pendingHeaders(pending),
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    track(pending, response);
    return { response, body: await response.text() };
  };

  const options = await send(AUTH_URL, "GET");
  if (!options.response.ok) {
    throw failure(
      "Loading the two-factor options",
      options.response,
      options.body,
    );
  }
  const parsed = parseJson(options.body);
  const phones = (
    isRecord(parsed) && Array.isArray(parsed.trustedPhoneNumbers)
      ? parsed.trustedPhoneNumbers.filter(isRecord)
      : []
  ).filter((phone) => typeof phone.id === "number");
  const phone = phones[0];
  const noDevices = isRecord(parsed) && parsed.noTrustedDevices === true;
  if (noDevices && !phone) {
    throw new AppleSignInError(
      "The Apple Account has no trusted device or phone number for two-factor codes.",
    );
  }
  const phoneMode = text(phone?.pushMode) ?? "sms";
  const destination = text(phone?.numberWithDialCode);
  const securityCode =
    isRecord(parsed) && isRecord(parsed.securityCode)
      ? parsed.securityCode.length
      : undefined;
  const length =
    typeof securityCode === "number" && securityCode > 0 ? securityCode : 6;

  const textCode = async () => {
    const requested = await send(`${AUTH_URL}/verify/phone`, "PUT", {
      phoneNumber: { id: phone!.id },
      mode: phoneMode,
    });
    if (!requested.response.ok) {
      throw failure(
        "Texting a two-factor code",
        requested.response,
        requested.body,
      );
    }
  };

  const verify = async (via: "device" | "sms", code: string) => {
    const verified =
      via === "device"
        ? await send(`${AUTH_URL}/verify/trusteddevice/securitycode`, "POST", {
            securityCode: { code },
          })
        : await send(`${AUTH_URL}/verify/phone/securitycode`, "POST", {
            securityCode: { code },
            phoneNumber: { id: phone!.id },
            mode: phoneMode,
          });
    if (verified.response.ok) return true;
    if ([400, 401, 403].includes(verified.response.status)) return false;
    throw failure(
      "Checking the two-factor code",
      verified.response,
      verified.body,
    );
  };
  const ask = async (via: "device" | "sms", afterWrongCode: boolean) => {
    const code = await prompts.twoFactorCode({
      via,
      destination,
      textsOnWrongCode: via === "device" && phone !== undefined,
      afterWrongCode,
      length,
    });
    if (code === undefined) throw new AppleSignInError(CANCELLED);
    return code;
  };

  // As Apple's sign-in page does: an Apple Account without trusted devices
  // gets a text at once. Otherwise a trusted device's code is asked for, and
  // a rejected one makes Apple text a code to the trusted phone, asked for
  // once more.
  let accepted: boolean;
  if (noDevices) {
    await textCode();
    accepted = await verify("sms", await ask("sms", false));
  } else {
    accepted = await verify("device", await ask("device", false));
    if (!accepted && phone) {
      await textCode();
      accepted = await verify("sms", await ask("sms", true));
    }
  }
  if (!accepted) {
    throw new AppleSignInError("Apple rejected the verification code.");
  }
  const trust = await send(`${AUTH_URL}/2sv/trust`, "GET");
  if (!trust.response.ok) {
    throw failure("Finishing the two-factor check", trust.response, trust.body);
  }
};

const parseProvider = (value: unknown): AppleProvider | undefined => {
  if (!isRecord(value) || typeof value.providerId !== "number")
    return undefined;
  const publicProviderId = text(value.publicProviderId);
  if (!publicProviderId) return undefined;
  return {
    providerId: value.providerId,
    publicProviderId,
    name: text(value.name),
  };
};

const readSession = async (client: Client) => {
  const response = await client.request(SESSION_URL, {
    headers: { Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new AppleSignInError(
      response.status === 401 || response.status === 403
        ? "App Store Connect didn't accept the sign-in. Check that the Apple Account is in an Apple Developer team."
        : `Loading the App Store Connect session failed (HTTP ${response.status}).`,
      { status: response.status, body },
    );
  }
  const parsed = parseJson(body);
  const provider = isRecord(parsed)
    ? parseProvider(parsed.provider)
    : undefined;
  if (!isRecord(parsed) || !provider) {
    throw new AppleSignInError(
      "App Store Connect's session names no team for the Apple Account.",
    );
  }
  const providers = (
    Array.isArray(parsed.availableProviders) ? parsed.availableProviders : []
  )
    .map(parseProvider)
    .filter((value): value is AppleProvider => value !== undefined);
  return {
    provider,
    providers: providers.some(
      (value) => value.providerId === provider.providerId,
    )
      ? providers
      : [provider, ...providers],
  };
};

/**
 * Signs in to App Store Connect with `appleId` and `password`, asking
 * `prompts` for the two-factor code. The session lives only in the returned
 * object's memory.
 */
export const signInToAppStoreConnect = async ({
  appleId,
  password,
  prompts,
  fetch = globalThis.fetch,
}: {
  appleId: string;
  password: string;
  prompts: AppleSignInPrompts;
  fetch?: typeof globalThis.fetch;
}): Promise<AppleWebSession> => {
  const client = createClient(fetch);
  try {
    const widgetKey = await findWidgetKey(fetch, client);
    const json = {
      "Content-Type": "application/json",
      "X-Apple-Widget-Key": widgetKey,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript",
    };

    const srp = createSrpClient();
    const init = await client.request(`${AUTH_URL}/signin/init`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        accountName: appleId,
        protocols: ["s2k", "s2k_fo"],
        a: srp.a,
      }),
    });
    const initBody = await init.text();
    if (!init.ok) throw failure("Starting the sign-in", init, initBody);
    const started = parseJson(initBody);
    if (
      !isRecord(started) ||
      typeof started.iteration !== "number" ||
      !text(started.salt) ||
      !text(started.b) ||
      !text(started.protocol)
    ) {
      throw new AppleSignInError("Apple's sign-in answered no SRP challenge.");
    }
    const { m1, m2 } = srp.proof({
      accountName: appleId,
      password,
      protocol: text(started.protocol)!,
      iterations: started.iteration,
      salt: text(started.salt)!,
      b: text(started.b)!,
    });

    const stamp = await hashcash(client, widgetKey);
    const complete = await client.request(
      `${AUTH_URL}/signin/complete?isRememberMeEnabled=false`,
      {
        method: "POST",
        headers: { ...json, ...(stamp ? { "X-Apple-HC": stamp } : {}) },
        body: JSON.stringify({
          accountName: appleId,
          rememberMe: false,
          m1,
          m2,
          c: started.c,
        }),
      },
    );
    const completeBody = await complete.text();
    if (complete.status === 409) {
      const sessionId = complete.headers.get("x-apple-id-session-id")?.trim();
      const scnt = complete.headers.get("scnt")?.trim();
      if (!sessionId || !scnt) {
        throw new AppleSignInError(
          "Apple asked for a two-factor code without a sign-in session.",
        );
      }
      await twoFactor(client, { widgetKey, sessionId, scnt }, prompts);
    } else if (!complete.ok) {
      const { codes } = serviceErrors(completeBody);
      const authType = (() => {
        const parsed = parseJson(completeBody);
        return isRecord(parsed) ? text(parsed.authType) : undefined;
      })();
      if (complete.status === 401 && codes.includes("-20101")) {
        throw new AppleSignInError("Apple rejected the email or password.", {
          status: 401,
        });
      }
      if (
        complete.status === 412 &&
        authType &&
        ["sa", "hsa", "non-sa", "hsa2"].includes(authType)
      ) {
        throw new AppleSignInError(
          "The Apple Account has a pending prompt. Sign in at https://appstoreconnect.apple.com once, then run this again.",
          { status: 412 },
        );
      }
      throw failure("Signing in", complete, completeBody);
    }

    let { provider, providers } = await readSession(client);
    return {
      appleId,
      get provider() {
        return provider;
      },
      get providers() {
        return providers;
      },
      selectProvider: async (publicProviderId) => {
        if (provider.publicProviderId === publicProviderId) return provider;
        const selected = providers.find(
          (value) => value.publicProviderId === publicProviderId,
        );
        if (!selected) {
          throw new AppleSignInError(
            `The Apple Account is in no team ${publicProviderId}.`,
          );
        }
        const response = await client.request(SESSION_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "olympus-ui",
          },
          body: JSON.stringify({
            provider: { providerId: selected.providerId },
          }),
        });
        const body = await response.text();
        if (!response.ok) {
          throw new AppleSignInError(
            `Switching to the team ${selected.name ?? publicProviderId} failed (HTTP ${response.status}).`,
            { status: response.status, body },
          );
        }
        ({ provider, providers } = await readSession(client));
        if (provider.providerId !== selected.providerId) {
          throw new AppleSignInError(
            `App Store Connect stayed in the team ${provider.name ?? provider.publicProviderId}.`,
          );
        }
        return provider;
      },
      request: client.request,
      clear: client.clear,
    };
  } catch (error) {
    client.clear();
    throw error;
  }
};
