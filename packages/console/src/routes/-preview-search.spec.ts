import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/components/features/preview/PreviewPage", () => ({
  PreviewPage: () => null,
}));

import { Route } from "./preview";

const validateSearch = (
  Route as unknown as {
    readonly options: {
      readonly validateSearch: (
        search: Record<string, unknown>,
      ) => Record<string, string>;
    };
  }
).options.validateSearch;

describe("Preview search", () => {
  it("keeps the build, channel, and page cursors a link opens", () => {
    expect(
      validateSearch({ build: "build-1", channel: "pr-12", before: "b" }),
    ).toEqual({ build: "build-1", channel: "pr-12", before: "b" });
  });

  it("drops a channel no channel link can carry", () => {
    expect(validateSearch({ channel: " pr-12" })).toEqual({});
    expect(validateSearch({ channel: "x".repeat(256), build: "" })).toEqual({});
  });
});
