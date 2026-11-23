import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BundleIdDisplay } from "./BundleIdDisplay";

const id = "01a13d86-86f7-7830-952d-21238207019f";

afterEach(cleanup);

describe("BundleIdDisplay", () => {
  it("clips a labeled release's ID to its tail, and reads and copies all of it", () => {
    render(
      <a href="#bundle">
        <BundleIdDisplay bundleId={id} label={14} />
      </a>,
    );

    const link = screen.getByRole("link", { name: `v14 ${id}` });
    expect(link.querySelector("[title]")?.getAttribute("title")).toBe(id);
    expect(link.textContent).toBe(`v14 ${id}·`);
    const shown = screen.getByText(id);
    expect(shown.className).toContain("w-[12ch]");
    expect(shown.className).toContain("overflow-hidden");
    expect(
      [...link.querySelectorAll("[aria-hidden=true]")].map(
        (part) => part.textContent,
      ),
    ).toEqual(["·"]);
  });

  it("shows a short ID whole beside its label", () => {
    render(<BundleIdDisplay bundleId="release-1" label={3} />);

    expect(screen.getByText("release-1").className).not.toContain(
      "overflow-hidden",
    );
  });

  it("shows the full ID of a release without a label", () => {
    render(<BundleIdDisplay bundleId={id} label={null} />);

    expect(screen.getByText(id)).toBeTruthy();
    expect(screen.queryByText("·")).toBeNull();
  });
});
