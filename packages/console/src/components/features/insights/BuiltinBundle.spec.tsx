import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EventBundleTransition } from "./EventDetails";

const builtin = "019a0000-0000-7000-8000-000000000000";
const deployed = "019b0000-0000-7000-8000-000000000001";
const release = "019b0000-0000-7a1b-9c2d-3e4f5a6b7c8d";

afterEach(cleanup);

/** The built-in bundle's copy button: its name, then the ID it copies. */
const builtinButton = (id: string, appVersion = "1.6.1") =>
  screen.getByRole("button", {
    name: `Built-in bundle · ${appVersion}: copy built-in bundle ID ${id}`,
  });

describe("EventBundleTransition", () => {
  it("names the bundle its native build shipped by the report's app version", () => {
    render(
      <EventBundleTransition
        event={{
          appVersion: "1.6.1",
          type: "UPDATE_APPLIED",
          fromBundleId: builtin,
          toBundleId: deployed,
          minBundleId: builtin,
        }}
      />,
    );
    expect(builtinButton(builtin).textContent).toBe("Built-in bundle · 1.6.1");
  });

  it("names a built-in bundle by its ID's shape when the report names no minBundleId", () => {
    // An SDK that reports no minBundleId, still on its build's bundle.
    render(
      <EventBundleTransition
        event={{
          appVersion: "1.6.1",
          type: "UNCHANGED",
          fromBundleId: null,
          toBundleId: builtin,
        }}
      />,
    );
    expect(builtinButton(builtin)).toBeDefined();
  });

  it.each([
    ["iOS", "019a0000-0000-7000-8000-01a1b2c3d4e5"],
    ["Android", "019a0000-0000-7000-8000-02a1b2c3d4e5"],
  ])(
    "names a built-in bundle of an earlier CLI %s build, with a platform byte, when the report names no minBundleId",
    (_platform, bundleId) => {
      render(
        <EventBundleTransition
          event={{
            appVersion: "1.6.1",
            type: "UNCHANGED",
            fromBundleId: null,
            toBundleId: bundleId,
          }}
        />,
      );
      expect(builtinButton(bundleId)).toBeDefined();
    },
  );

  it("marks a release that serves the built-in bundle beside its release ID", () => {
    render(
      <EventBundleTransition
        event={{
          appVersion: "1.6.1",
          type: "UNCHANGED",
          fromBundleId: null,
          toBundleId: builtin,
          toReleaseId: release,
          minBundleId: builtin,
        }}
      />,
    );
    expect(screen.getByText("Built-in bundle")).toBeDefined();
    expect(
      screen.getByRole("button", { name: `Copy ID ${release}` }),
    ).toBeDefined();
  });

  it("names no deployed bundle, whose ID has random bits", () => {
    render(
      <EventBundleTransition
        event={{
          appVersion: "1.6.1",
          type: "UPDATE_APPLIED",
          fromBundleId: "019a0000-0000-7123-8456-0123456789ab",
          toBundleId: deployed,
        }}
      />,
    );
    expect(screen.queryByText(/Built-in bundle/)).toBeNull();
  });
});
