import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleSelector } from "./BundleSelector";

describe("BundleSelector", () => {
  afterEach(cleanup);

  it("recovers an empty search, filters by metadata, and selects a bundle", () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onBundleChange = vi.fn();
    render(
      <BundleSelector
        bundleId="bundle-a"
        bundles={[
          { bundleId: "bundle-a", description: "iOS · production · 1.0.0" },
          { bundleId: "bundle-b", description: "Android · production · 1.0.0" },
        ]}
        onBundleChange={onBundleChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: "Artifact to inspect" }),
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search artifacts" }),
      {
        target: { value: "no-matching-bundle" },
      },
    );
    expect(screen.getByText("No artifacts found")).toBeDefined();
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.change(
      screen.getByRole("combobox", { name: "Search artifacts" }),
      {
        target: { value: "Android" },
      },
    );

    expect(screen.queryByRole("option", { name: /bundle-a/i })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /bundle-b/i }));

    expect(onBundleChange).toHaveBeenCalledWith("bundle-b");
  });
});
