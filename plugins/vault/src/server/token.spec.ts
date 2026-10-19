import { describe, expect, it } from "vitest";

import {
  generateVaultToken,
  hashVaultToken,
  isVaultToken,
  randomId,
} from "./token";

describe("vault tokens", () => {
  it("are hu_vault_ and 32 random bytes, stored as their SHA-256 digest", async () => {
    const token = generateVaultToken();
    expect(token).toMatch(/^hu_vault_[A-Za-z0-9_-]{43}$/u);
    expect(isVaultToken(token)).toBe(true);
    expect(generateVaultToken()).not.toBe(token);

    const hash = await hashVaultToken(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(hashVaultToken(token)).resolves.toBe(hash);
    await expect(hashVaultToken("hu_vault_short")).rejects.toThrow(TypeError);
  });

  it("makes row ids that fit the vault's id columns", () => {
    const id = randomId("sec");
    expect(id).toMatch(/^sec-[A-Za-z0-9_-]{22}$/u);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});
