import { isUUIDv7 } from "@hot-updater/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUUIDv7 } from "./uuidv7";

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
