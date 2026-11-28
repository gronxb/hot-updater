import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactIdDisplay } from "./ArtifactIdDisplay";

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
  writeText.mockReset();
});

describe("ArtifactIdDisplay", () => {
  it("shows an artifact's ID as its last 12 characters, a button that copies the whole ID", () => {
    render(<ArtifactIdDisplay artifactId={id} />);

    const copy = screen.getByRole("button", {
      name: `Copy artifact ID ${id}`,
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

  it("says in its popover that the ID is an artifact's", async () => {
    render(<ArtifactIdDisplay artifactId={id} />);
    const copy = screen.getByRole("button", {
      name: `Copy artifact ID ${id}`,
    });

    act(() => copy.focus());
    const tooltip = await screen.findByRole("tooltip", {}, { timeout: 2_000 });
    expect(within(tooltip).getByText("Artifact ID")).toBeTruthy();
    expect(within(tooltip).getByText(id)).toBeTruthy();
  });

  it("holds no button inside a link, and shows the full ID on hover there", () => {
    render(
      <a href="#artifact">
        <ArtifactIdDisplay artifactId={id} copyable={false} />
      </a>,
    );

    const link = screen.getByRole("link");
    expect(within(link).queryByRole("button")).toBeNull();
    const text = within(link).getByText(id);
    expect(text.className).toContain("w-[12ch]");
    expect(text.getAttribute("title")).toBe(id);
  });
});
