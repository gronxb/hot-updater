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
    const options = { id, parse: String };

    const create = () => Reflect.apply(defineCapability, undefined, [options]);

    expect(create).toThrow(TypeError);
  });

  it("rejects a non-callable parser", () => {
    const options = { id: "example@1", parse: "not-a-parser" };

    const create = () => Reflect.apply(defineCapability, undefined, [options]);

    expect(create).toThrow(TypeError);
  });
});
