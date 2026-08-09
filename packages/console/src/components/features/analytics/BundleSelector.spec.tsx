import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleSelector } from "./BundleSelector";

describe("BundleSelector", () => {
  afterEach(cleanup);

  it("filters by metadata and selects the bundle to inspect", () => {
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
      screen.getByRole("combobox", { name: "Bundle to inspect" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Search bundles" }), {
      target: { value: "Android" },
    });

    expect(screen.queryByRole("option", { name: /bundle-a/i })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /bundle-b/i }));

    expect(onBundleChange).toHaveBeenCalledWith("bundle-b");
  });
});
