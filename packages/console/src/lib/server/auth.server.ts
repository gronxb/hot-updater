import type {
  ConsoleAccess,
  ConsoleAuthProvider,
  ConsolePrincipal,
} from "../../index";
import { getConsoleAuthAdapter } from "./console-runtime.server";

const accessError = (
  access: Exclude<ConsoleAccess, { status: "authorized" }>,
) =>
  new Response(
    access.status === "unauthenticated" ? "Unauthorized" : "Forbidden",
    { status: access.status === "unauthenticated" ? 401 : 403 },
  );

// Server function middleware checks access before input, and prepareConfig
// checks again for its callers: one request asks the adapter once.
const accessByRequest = new WeakMap<Request, Promise<ConsoleAccess>>();

export const getConsoleAccess = (request: Request): Promise<ConsoleAccess> => {
  let access = accessByRequest.get(request);
  if (!access) {
    access = getConsoleAuthAdapter().then((adapter) =>
      adapter.getAccess(request),
    );
    accessByRequest.set(request, access);
  }
  return access;
};

export const getConsoleAuthProviders = async (
  request: Request,
): Promise<readonly ConsoleAuthProvider[]> => {
  const adapter = await getConsoleAuthAdapter();
  return adapter.getProviders(request);
};

export const handleConsoleAuth = async (request: Request) => {
  const adapter = await getConsoleAuthAdapter();
  return adapter.handle(request);
};

export const requireConsoleAccess = async (
  request: Request,
): Promise<ConsolePrincipal> => {
  const access = await getConsoleAccess(request);
  if (access.status !== "authorized") {
    throw accessError(access);
  }
  return access.principal;
};
