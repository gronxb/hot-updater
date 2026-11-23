import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BundleIdDisplay } from "./BundleIdDisplay";

const id = "01a13d86-86f7-7830-952d-21238207019f";

afterEach(cleanup);

describe("BundleIdDisplay", () => {
  it("shows a label and its ID tail, and reads and copies the full ID", () => {
    render(
      <a href="#bundle">
        <BundleIdDisplay bundleId={id} label={14} />
      </a>,
    );

    const link = screen.getByRole("link", { name: `v14 ${id}` });
    expect(link.querySelector("[title]")?.getAttribute("title")).toBe(id);
    const shown = [...link.querySelectorAll("[aria-hidden=true]")].map(
      (part) => part.textContent,
    );
    expect(shown).toEqual(["·", "21238207019f"]);
    expect(link.textContent).toMatch(new RegExp(`^v14 ${id}`));
  });

  it("shows the full ID of a release without a label", () => {
    render(<BundleIdDisplay bundleId={id} label={null} />);

    expect(screen.getByText(id)).toBeTruthy();
    expect(screen.queryByText("·")).toBeNull();
  });
});
