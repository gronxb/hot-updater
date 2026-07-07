import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { Pool } from "pg";

import { getAuthEnv } from "./auth-env.server.ts";

let authDatabasePool: Pool | null = null;
let authInstance: ReturnType<typeof createConsoleAuth> | null = null;

const getAuthDatabasePool = (databaseURL: string) => {
  authDatabasePool ??= new Pool({
    connectionString: databaseURL,
  });

  return authDatabasePool;
};

export const createConsoleAuth = () => {
  const env = getAuthEnv();

  return betterAuth({
    baseURL: env.baseURL,
    database: getAuthDatabasePool(env.databaseURL),
    emailAndPassword: {
      disableSignUp: true,
      enabled: true,
    },
    plugins: [admin()],
    secret: env.secret,
    trustedOrigins: [...env.trustedOrigins],
  });
};

export const getAuth = () => {
  authInstance ??= createConsoleAuth();
  return authInstance;
};

export const closeAuthDatabase = async () => {
  const pool = authDatabasePool;
  authDatabasePool = null;
  authInstance = null;
  await pool?.end();
};
