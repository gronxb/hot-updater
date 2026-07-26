import { describe, expect, it } from "vitest";

import { defineCapability } from "./capabilities";

describe("capability token versioning", () => {
  it.each([
    "",
    "@1",
    "example",
    "example@",
    "example@1.5",
    "example@-1",
    "example@1x",
    "example@1@2",
    "example@1\n",
  ])("rejects the invalid runtime capability id %j", (id) => {
    // Given
    const options = {
      id,
      parse: (value: unknown) => String(value),
    };

    // When
    const create = () => Reflect.apply(defineCapability, undefined, [options]);

    // Then
    expect(create).toThrow(TypeError);
  });
});
