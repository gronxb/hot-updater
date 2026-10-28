import { describe, expect, it, vi } from "vitest";

import { revokeGoogleToken, signInWithGoogle } from "./googleSignIn";

const client = { clientId: "client.apps.googleusercontent.com" };
const scopes = ["https://www.googleapis.com/auth/androidpublisher"];

/** The browser: Google sends it back to the loopback with a code. */
const answer = async (url: string) => {
  const signIn = new URL(url);
  const redirect = new URL(signIn.searchParams.get("redirect_uri")!);
  redirect.search = new URLSearchParams({
    code: "4/auth-code",
    state: signIn.searchParams.get("state")!,
  }).toString();
  await globalThis.fetch(redirect);
};

describe("signInWithGoogle", () => {
  it("names a sign-in the browser never finishes", async () => {
    await expect(
      signInWithGoogle({ client, scopes, onUrl: () => {}, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: "sign-in-cancelled",
      message: "The Google sign-in did not finish in time.",
    });
  });

  it("names an OAuth client Google does not know", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: "invalid_client",
          error_description: "The OAuth client was not found.",
        },
        { status: 401 },
      ),
    );

    await expect(
      signInWithGoogle({ client, scopes, onUrl: answer, fetch }),
    ).rejects.toMatchObject({
      code: "sign-in-not-configured",
      message:
        "Google refused the sign-in (HTTP 401).\nThe OAuth client was not found.",
    });
  });

  it("sends no client secret for a client without one", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ access_token: "ya29.t", scope: scopes[0] }),
    );

    await expect(
      signInWithGoogle({
        client,
        scopes,
        onUrl: answer,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ accessToken: "ya29.t", scopes });
    const form = new URLSearchParams(String(fetch.mock.calls[0]![1]!.body));
    expect(form.has("client_secret")).toBe(false);
  });
});

describe("revokeGoogleToken", () => {
  it("reports a revocation Google never answered", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      revokeGoogleToken("ya29.t", fetch as unknown as typeof globalThis.fetch),
    ).resolves.toBe(false);
  });
});
