// import { beforeAll, describe, expect, it, vi } from "vitest";
// import type { UpdateSource } from "./types";

import { describe, expect, it } from "vitest";
import { getNextUpdate } from "./getNextUpdate";
import type { UpdateSource } from "./types";

describe("appVersion 1.0, bundleVersion null", async () => {
  it("should return null if no update information is available", async () => {
    const updateSource: UpdateSource[] = [];

    const update = await getNextUpdate("1.0");
    expect(update).toStrictEqual({});
  });
});
