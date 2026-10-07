import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EventBundleTransition } from "./EventDetails";

const builtin = "019a0000-0000-7000-8000-000000000000";

afterEach(cleanup);

describe("EventBundleTransition", () => {
  it("marks the bundle its native build shipped", () => {
    render(
      <EventBundleTransition
        event={{
          type: "UPDATE_APPLIED",
          fromBundleId: builtin,
          toBundleId: "019b0000-0000-7000-8000-000000000001",
          minBundleId: builtin,
        }}
      />,
    );
    expect(screen.getAllByText("Built-in app")).toHaveLength(1);
    expect(
      screen.getByText("Built-in app").closest("dd")?.textContent,
    ).toContain(builtin.slice(0, 8));
  });

  it("marks nothing when the report does not name the built-in bundle", () => {
    render(
      <EventBundleTransition
        event={{
          type: "UPDATE_APPLIED",
          fromBundleId: builtin,
          toBundleId: "019b0000-0000-7000-8000-000000000001",
        }}
      />,
    );
    expect(screen.queryByText("Built-in app")).toBeNull();
  });
});
