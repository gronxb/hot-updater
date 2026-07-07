import {
  getRequestHeaders,
  setResponseStatus,
} from "@tanstack/react-start/server";

import { getAuth } from "./auth-factory.server.ts";

const UNAUTHORIZED_STATUS = 401;

export class ConsoleUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "ConsoleUnauthorizedError";
  }
}

export const getConsoleSession = async () => {
  const headers = getRequestHeaders();
  return getAuth().api.getSession({ headers });
};

export const requireConsoleSession = async () => {
  const session = await getConsoleSession();

  if (!session) {
    setResponseStatus(UNAUTHORIZED_STATUS);
    throw new ConsoleUnauthorizedError();
  }

  return session;
};
