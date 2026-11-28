import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallIdDisplay } from "./InstallIdDisplay";

const id = "8d2f0c1e-4b7a-4e6d-9f3c-2a1b0c9d8e7f";
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
  writeText.mockReset();
});

describe("InstallIdDisplay", () => {
  it("shows an installation's ID as its last 12 characters, a button that copies the whole ID", () => {
    render(<InstallIdDisplay installId={id} />);

    const copy = screen.getByRole("button", {
      name: `Copy install ID ${id}`,
    });
    expect(copy.textContent).toBe(id);
    expect(copy.firstElementChild!.className).toContain("w-[12ch]");
    expect(copy.firstElementChild!.className).toContain("overflow-hidden");
    expect(copy.className).toContain("font-mono");
    expect(copy.className).toContain("text-xs");
    expect(copy.getAttribute("translate")).toBe("no");
    fireEvent.click(copy);
    expect(writeText).toHaveBeenLastCalledWith(id);
  });

  it("says in its popover that the ID is an install ID", async () => {
    render(<InstallIdDisplay installId={id} />);
    const copy = screen.getByRole("button", {
      name: `Copy install ID ${id}`,
    });

    act(() => copy.focus());
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: 2_000 });
    expect(within(tooltip).getByText("Install ID")).toBeTruthy();
    expect(within(tooltip).getByText(id)).toBeTruthy();
  });

  it("holds no button inside a link, and shows the full ID on hover there", () => {
    render(
      <a href="#installation">
        <InstallIdDisplay installId={id} copyable={false} />
      </a>,
    );

    const link = screen.getByRole("link");
    expect(within(link).queryByRole("button")).toBeNull();
    const text = within(link).getByText(id);
    expect(text.className).toContain("w-[12ch]");
    expect(text.getAttribute("title")).toBe(id);
  });
});
