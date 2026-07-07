// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { getAdminBootstrapEnv, getAuthEnv } from "./auth-env.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth env", () => {
  it("requires explicit auth runtime settings", () => {
    expect(() => getAuthEnv()).toThrow(
      "BETTER_AUTH_URL is required for Hot Updater Console auth.",
    );

    vi.stubEnv("BETTER_AUTH_URL", "https://console.example.com");

    expect(() => getAuthEnv()).toThrow(
      "AUTH_DATABASE_URL is required for Hot Updater Console auth.",
    );
  });

  it("parses auth database, secret, and trusted origins", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://console.example.com");
    vi.stubEnv("AUTH_DATABASE_URL", "postgres://auth.example.com/auth");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-value");
    vi.stubEnv(
      "BETTER_AUTH_TRUSTED_ORIGINS",
      "https://console.example.com, https://preview.example.com ",
    );

    expect(getAuthEnv()).toEqual({
      baseURL: "https://console.example.com",
      databaseURL: "postgres://auth.example.com/auth",
      secret: "secret-value",
      trustedOrigins: [
        "https://console.example.com",
        "https://preview.example.com",
      ],
    });
  });

  it("defaults trusted origins to the auth base URL", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://console.example.com");
    vi.stubEnv("AUTH_DATABASE_URL", "postgres://auth.example.com/auth");
    vi.stubEnv("BETTER_AUTH_SECRET", "secret-value");

    expect(getAuthEnv().trustedOrigins).toEqual([
      "https://console.example.com",
    ]);
  });

  it("requires first-admin credentials and normalizes the email", () => {
    vi.stubEnv("HOT_UPDATER_CONSOLE_ADMIN_EMAIL", " ADMIN@EXAMPLE.COM ");
    vi.stubEnv("HOT_UPDATER_CONSOLE_ADMIN_PASSWORD", "password-value");

    expect(getAdminBootstrapEnv()).toEqual({
      email: "admin@example.com",
      name: "admin@example.com",
      password: "password-value",
    });
  });
});
