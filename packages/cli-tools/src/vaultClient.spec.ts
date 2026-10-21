import { afterEach, describe, expect, it, vi } from "vitest";

import { maskSecretValues } from "./secretMasking";
import { createVaultClient, VaultRequestError } from "./vaultClient";

const TOKEN = `hu_vault_${"C".repeat(43)}`;

const answer = (response: Response) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  return fetch;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createVaultClient", () => {
  it("reaches the vault beneath the Console's URL, keeping its path, and masks the token", async () => {
    const fetch = answer(Response.json({ secrets: [] }));
    const client = createVaultClient({
      url: "https://example.com/console/",
      token: TOKEN,
      fetch,
    });

    await expect(client.list()).resolves.toEqual([]);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://example.com/console/_hot-updater/vault/v1/secrets",
    );
    expect(client.url).toBe("https://example.com/console");
    expect(maskSecretValues(`Bearer ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("takes plain HTTP only to this machine", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      expect(() => createVaultClient({ url, token: TOKEN })).not.toThrow();
    }
    expect(() =>
      createVaultClient({ url: "http://console.example.com", token: TOKEN }),
    ).toThrow(
      "HOT_UPDATER_CONSOLE_URL is http://console.example.com, and the vault token and secrets travel only over HTTPS, or HTTP to localhost: use the Console's https:// URL.",
    );
    expect(() =>
      createVaultClient({ url: "console.example.com", token: TOKEN }),
    ).toThrow(VaultRequestError);
  });

  it("sends a write to the secret's route and returns only its metadata", async () => {
    const secret = { id: "sec-1", name: "ota-key", kind: "bundle-signing-key" };
    const fetch = answer(Response.json({ secret }, { status: 201 }));
    const client = createVaultClient({
      url: "https://console.example.com",
      token: TOKEN,
      fetch,
    });

    await expect(
      client.put({
        name: "ota-key",
        kind: "bundle-signing-key",
        value: { privateKey: "LS0t" },
      }),
    ).resolves.toEqual(secret);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://console.example.com/_hot-updater/vault/v1/secrets/ota-key",
    );
    expect(init).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        kind: "bundle-signing-key",
        value: { privateKey: "LS0t" },
      }),
    });
  });

  it("sends the version a write expects, such as 0 for a new secret only", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { code: "conflict", message: "The secret is at version 1." } },
        { status: 409 },
      ),
    );
    const client = createVaultClient({
      url: "https://console.example.com",
      token: TOKEN,
      fetch,
    });

    await expect(
      client.put({
        name: "ota-key",
        kind: "bundle-signing-key",
        value: { privateKey: "LS0t" },
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      kind: "bundle-signing-key",
      value: { privateKey: "LS0t" },
      expectedVersion: 0,
    });
  });

  it("says when the URL serves no vault", async () => {
    const client = createVaultClient({
      url: "https://example.com",
      token: TOKEN,
      fetch: answer(new Response("Not Found", { status: 404 })),
    });

    const error = await client.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultRequestError);
    expect(error).toMatchObject({
      status: 404,
      message:
        "https://example.com serves no vault at /_hot-updater/vault/v1/: check that HOT_UPDATER_CONSOLE_URL is the Console's URL.",
    });
  });
});
