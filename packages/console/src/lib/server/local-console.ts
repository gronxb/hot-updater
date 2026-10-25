/**
 * The variable `hot-updater console` passes the console it starts its
 * per-run session secret in. Without it, the local console serves no page
 * and no server function, only the `/_hot-updater/` routes, which
 * authenticate each request themselves.
 */
export const LOCAL_CONSOLE_SESSION_ENV = "HOT_UPDATER_CONSOLE_SESSION";

/** The query parameter of the link `hot-updater console` prints. */
export const LOCAL_CONSOLE_SESSION_PARAM = "hot-updater-session";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Routes that authenticate each request themselves, by vault token. */
const SELF_AUTHENTICATED_PREFIX = "/_hot-updater/";

export interface LocalConsoleGuardOptions {
  /** The run's session secret; without one, every page is refused. */
  readonly session: string | undefined;
  /** The port the console listens on; any loopback port when unknown. */
  readonly port: string | undefined;
  /**
   * Whether to check the `Host` header. Vite's dev server checks it
   * itself, against its `server.allowedHosts`.
   */
  readonly checkHost: boolean;
}

/** Compares in time that depends only on the lengths. */
const sameSecret = (given: string, expected: string): boolean => {
  if (given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < given.length; index += 1) {
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
};

/**
 * The session cookie's name. Browsers send a cookie to every port of a
 * host, so the port keeps two local consoles' sessions apart.
 */
const cookieName = (port: string | undefined) =>
  port === undefined
    ? "hot_updater_console_session"
    : `hot_updater_console_session_${port}`;

const cookieOf = (request: Request, name: string): string | undefined => {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
};

/** `host` when it names this machine on `port`, or undefined. */
const loopbackHost = (
  host: string | null,
  port: string | undefined,
): string | undefined => {
  if (host === null) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  if (
    parsed.host !== host.toLowerCase() ||
    !LOOPBACK_HOSTNAMES.has(parsed.hostname) ||
    (port !== undefined && parsed.port !== port)
  ) {
    return undefined;
  }
  return parsed.host;
};

const refuse = (status: 401 | 403, message: string) =>
  new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });

/**
 * What the local console answers before a request reaches a page, a server
 * function, or a route, or undefined to let it through:
 *
 * - a `Host` that is not this machine on the console's port is refused, so
 *   a site that rebinds its name to 127.0.0.1 reaches nothing;
 * - a request that changes something from another origin is refused;
 * - the `/_hot-updater/` routes pass, as they authenticate by vault token;
 * - the link `hot-updater console` prints carries the run's session secret,
 *   which becomes an HttpOnly, SameSite=Strict cookie, and every other page
 *   and server function needs that cookie, so another user of the machine
 *   or a local process without the secret reaches nothing.
 */
export const guardLocalConsoleRequest = (
  request: Request,
  { session, port, checkHost }: LocalConsoleGuardOptions,
): Response | undefined => {
  const host = request.headers.get("host");
  const allowedHost = checkHost ? loopbackHost(host, port) : (host ?? "");
  if (allowedHost === undefined) {
    return refuse(
      403,
      `This console answers only at http://localhost${port === undefined ? "" : `:${port}`}.`,
    );
  }
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (
      (origin !== null && origin !== `http://${allowedHost}`) ||
      (site !== null && site !== "same-origin" && site !== "none")
    ) {
      return refuse(403, "This console takes changes only from its own pages.");
    }
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith(SELF_AUTHENTICATED_PREFIX)) return undefined;

  const name = cookieName(port);
  const given = url.searchParams.get(LOCAL_CONSOLE_SESSION_PARAM);
  if (session && given !== null && sameSecret(given, session)) {
    url.searchParams.delete(LOCAL_CONSOLE_SESSION_PARAM);
    return new Response(null, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        location: `${url.pathname}${url.search}${url.hash}`,
        "set-cookie": `${name}=${session}; Path=/; HttpOnly; SameSite=Strict`,
      },
    });
  }
  const cookie = cookieOf(request, name);
  if (session && cookie !== undefined && sameSecret(cookie, session)) {
    return undefined;
  }
  return refuse(
    401,
    session
      ? "Open this console with the link hot-updater console printed."
      : "Start this console with hot-updater console, and open the link it prints.",
  );
};
