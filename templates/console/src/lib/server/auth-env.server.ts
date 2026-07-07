export interface AuthEnv {
  readonly baseURL: string;
  readonly databaseURL: string;
  readonly secret: string;
  readonly trustedOrigins: readonly string[];
}

export interface AdminBootstrapEnv {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}

const requireEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Hot Updater Console auth.`);
  }

  return value;
};

const parseTrustedOrigins = (
  value: string | undefined,
  fallbackOrigin: string,
) => {
  const origins =
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0) ?? [];

  return origins.length > 0 ? origins : [fallbackOrigin];
};

export const getAuthEnv = (): AuthEnv => {
  const baseURL = requireEnv("BETTER_AUTH_URL");

  return {
    baseURL,
    databaseURL: requireEnv("AUTH_DATABASE_URL"),
    secret: requireEnv("BETTER_AUTH_SECRET"),
    trustedOrigins: parseTrustedOrigins(
      process.env.BETTER_AUTH_TRUSTED_ORIGINS,
      baseURL,
    ),
  };
};

export const getAdminBootstrapEnv = (): AdminBootstrapEnv => {
  const email = requireEnv("HOT_UPDATER_CONSOLE_ADMIN_EMAIL").toLowerCase();

  return {
    email,
    name: process.env.HOT_UPDATER_CONSOLE_ADMIN_NAME?.trim() || email,
    password: requireEnv("HOT_UPDATER_CONSOLE_ADMIN_PASSWORD"),
  };
};
