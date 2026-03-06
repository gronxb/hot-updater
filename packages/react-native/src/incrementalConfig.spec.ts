import { describe, expect, it } from "vitest";
import { resolveIncrementalConfig } from "./incrementalConfig";

describe("resolveIncrementalConfig", () => {
  it("disables incremental when option is undefined", () => {
    expect(resolveIncrementalConfig(undefined)).toEqual({
      enabled: false,
      strategy: "manifest",
    });
  });

  it("maps boolean true to enabled manifest mode", () => {
    expect(resolveIncrementalConfig(true)).toEqual({
      enabled: true,
      strategy: "manifest",
    });
  });

  it("supports object strategy for bsdiff", () => {
    expect(
      resolveIncrementalConfig({
        enable: true,
        strategy: "bsdiff",
      }),
    ).toEqual({
      enabled: true,
      strategy: "bsdiff",
    });
  });

  it("treats object without enable as enabled", () => {
    expect(
      resolveIncrementalConfig({
        strategy: "manifest",
      }),
    ).toEqual({
      enabled: true,
      strategy: "manifest",
    });
  });
});
