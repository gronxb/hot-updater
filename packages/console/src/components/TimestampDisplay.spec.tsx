import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TimestampDisplay } from "./TimestampDisplay";

describe("TimestampDisplay", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an empty timestamp fallback for non-uuid bundle ids", () => {
    expect(() =>
      render(<TimestampDisplay uuid="qa_lifecycle_new" />),
    ).not.toThrow();
    expect(screen.getByText("-")).toBeTruthy();
  });
});
