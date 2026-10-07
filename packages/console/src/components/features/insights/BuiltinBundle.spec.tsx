import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EventBundleTransition } from "./EventDetails";

const builtin = "019a0000-0000-7000-8000-000000000000";
const deployed = "019b0000-0000-7000-8000-000000000001";

afterEach(cleanup);

describe("EventBundleTransition", () => {
  it("marks the bundle its native build shipped", () => {
    render(
      <EventBundleTransition
        event={{
          type: "UPDATE_APPLIED",
          fromBundleId: builtin,
          toBundleId: deployed,
          minBundleId: builtin,
        }}
      />,
    );
    expect(screen.getAllByText("Built-in bundle")).toHaveLength(1);
    expect(
      screen.getByText("Built-in bundle").closest("dd")?.textContent,
    ).toContain(builtin.slice(0, 8));
  });

  it("marks a built-in bundle by its ID when the report names no minBundleId", () => {
    // An SDK that reports no minBundleId, still on its build's bundle.
    render(
      <EventBundleTransition
        event={{ type: "UNCHANGED", fromBundleId: null, toBundleId: builtin }}
      />,
    );
    expect(
      screen.getByText("Built-in bundle").closest("dd")?.textContent,
    ).toContain(builtin.slice(0, 8));
  });

  it("marks no deployed bundle, whose ID has random bits", () => {
    render(
      <EventBundleTransition
        event={{
          type: "UPDATE_APPLIED",
          fromBundleId: "019a0000-0000-7123-8456-0123456789ab",
          toBundleId: deployed,
        }}
      />,
    );
    expect(screen.queryByText("Built-in bundle")).toBeNull();
  });
});
