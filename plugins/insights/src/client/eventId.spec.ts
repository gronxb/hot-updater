import { createHash } from "node:crypto";

import { isUUIDv7 } from "@hot-updater/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKeyedUUIDv7, createUUIDv7, sha256 } from "./eventId";

describe("createUUIDv7", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    { label: "Web Crypto", crypto: globalThis.crypto },
    { label: "no Web Crypto, as in React Native", crypto: undefined },
  ])("leads with the 48-bit millisecond time using $label", ({ crypto }) => {
    vi.useFakeTimers({ now: 0x0192_3456_789a });
    vi.stubGlobal("crypto", crypto);

    const id = createUUIDv7();

    expect(isUUIDv7(id)).toBe(true);
    expect(id.startsWith("01923456-789a-7")).toBe(true);
    expect(createUUIDv7()).not.toBe(id);
  });
});

describe("sha256", () => {
  it.each([
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(1_000),
    "install-id\n2026-09-30\ndownload hash_mismatch bundle-id",
    "한글 및 이모지 😀",
  ])("matches Node's SHA-256 for %j", (value) => {
    expect(Buffer.from(sha256(value)).toString("hex")).toBe(
      createHash("sha256").update(value, "utf8").digest("hex"),
    );
  });
});

describe("createKeyedUUIDv7", () => {
  it("gives one UUIDv7 per key and time, led by that time", () => {
    const midnight = Date.UTC(2026, 8, 30);

    const id = createKeyedUUIDv7("install-id\nfailure", midnight);

    expect(isUUIDv7(id)).toBe(true);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(midnight);
    expect(createKeyedUUIDv7("install-id\nfailure", midnight)).toBe(id);
    expect(createKeyedUUIDv7("install-id\nother", midnight)).not.toBe(id);
    expect(
      createKeyedUUIDv7("install-id\nfailure", midnight + 86_400_000),
    ).not.toBe(id);
  });
});
