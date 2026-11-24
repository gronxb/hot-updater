import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleIdDisplay } from "./BundleIdDisplay";

const id = "01a13d86-86f7-7830-952d-21238207019f";
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  writeText.mockReset();
});

describe("BundleIdDisplay", () => {
  it("shows a labeled release as its label and the last 6 characters of its ID, and reads all of it", () => {
    render(<BundleIdDisplay bundleId={id} label={14} />);

    const copy = screen.getByRole("button", { name: `Copy ID ${id}` });
    // The whole ID is in the text, clipped to its tail in the label's size.
    expect(copy.textContent).toBe(id);
    expect(copy.className).toContain("w-[6ch]");
    expect(copy.className).toContain("overflow-hidden");
    expect(copy.className).toContain("text-sm");
    expect(copy.className).toContain("font-mono");
    const display = copy.parentElement!;
    expect(display.className).toContain("items-baseline");
    // No dot between them, and no hover-only title: the popover shows it.
    expect(display.textContent).toBe(`v14 ${id}`);
    expect(display.querySelector("[title]")).toBeNull();
    expect(display.querySelector("[aria-hidden=true]")).toBeNull();
  });

  it("shows the full ID in a popover when the tail is hovered or focused", async () => {
    render(<BundleIdDisplay bundleId={id} label={14} />);
    const copy = screen.getByRole("button", { name: `Copy ID ${id}` });

    fireEvent.mouseEnter(copy);
    fireEvent.pointerEnter(copy);
    fireEvent.mouseMove(copy);
    const hovered = await screen.findByRole("tooltip", {}, { timeout: 2_000 });
    expect(within(hovered).getByText(id)).toBeTruthy();
    expect(within(hovered).getByText("Click to copy")).toBeTruthy();

    cleanup();
    render(<BundleIdDisplay bundleId={id} label={14} />);
    act(() => screen.getByRole("button", { name: `Copy ID ${id}` }).focus());
    const focused = await screen.findByRole("tooltip", {}, { timeout: 2_000 });
    expect(within(focused).getByText(id)).toBeTruthy();
  });

  it("copies the full ID on a click and says so in the popover", async () => {
    render(<BundleIdDisplay bundleId={id} label={14} />);

    fireEvent.click(screen.getByRole("button", { name: `Copy ID ${id}` }));

    expect(writeText).toHaveBeenCalledWith(id);
    const popover = await screen.findByRole("tooltip");
    expect(within(popover).getByText(id)).toBeTruthy();
    expect(await within(popover).findByText("Copied")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("ID copied");
  });

  it("says when the ID couldn't be copied", async () => {
    writeText.mockRejectedValue(new Error("Denied"));
    render(<BundleIdDisplay bundleId={id} label={14} />);

    fireEvent.click(screen.getByRole("button", { name: `Copy ID ${id}` }));

    const popover = await screen.findByRole("tooltip");
    expect(await within(popover).findByText("Couldn't copy")).toBeTruthy();
  });

  it("keeps the click from the row it sits in", () => {
    const openRow = vi.fn();
    render(
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={openRow}>
        <BundleIdDisplay bundleId={id} label={14} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: `Copy ID ${id}` }));

    expect(writeText).toHaveBeenCalledWith(id);
    expect(openRow).not.toHaveBeenCalled();
  });

  it("renders the label as the caller's control, with the tail its own button beside it", () => {
    const open = vi.fn();
    render(
      <BundleIdDisplay
        bundleId={id}
        label={14}
        labelAs={<button type="button" aria-label="Open" onClick={open} />}
      />,
    );

    const label = screen.getByRole("button", { name: "Open" });
    const copy = screen.getByRole("button", { name: `Copy ID ${id}` });
    expect(label.textContent).toBe("v14");
    expect(label.contains(copy)).toBe(false);
    fireEvent.click(label);
    expect(open).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("holds no button inside another control, and shows the full ID on hover there", () => {
    render(
      <a href="#bundle">
        <BundleIdDisplay bundleId={id} copyable={false} label={14} />
      </a>,
    );

    const link = screen.getByRole("link", { name: `v14 ${id}` });
    expect(within(link).queryByRole("button")).toBeNull();
    expect(link.querySelector("[title]")?.getAttribute("title")).toBe(id);
    expect(screen.getByText(id).className).toContain("w-[6ch]");
  });

  it("shows a short ID whole beside its label", () => {
    render(<BundleIdDisplay bundleId="r-1" label={3} />);

    expect(screen.getByText("r-1").className).not.toContain("overflow-hidden");
  });

  it("shows the full ID of a release without a label", () => {
    render(<BundleIdDisplay bundleId={id} label={null} />);

    expect(screen.getByText(id)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
