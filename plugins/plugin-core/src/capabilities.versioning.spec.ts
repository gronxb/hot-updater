import { describe, expect, it } from "vitest";

import { defineCapability } from "./capabilities";

describe("capability option parsing", () => {
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
    const options = { id, parse: String };

    // When
    const create = () => Reflect.apply(defineCapability, undefined, [options]);

    // Then
    expect(create).toThrow(TypeError);
  });

  it("rejects a non-callable parser", () => {
    // Given
    const options = { id: "example@1", parse: "not-a-parser" };

    // When
    const create = () => Reflect.apply(defineCapability, undefined, [options]);

    // Then
    expect(create).toThrow(TypeError);
  });
});
