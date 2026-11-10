import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme } from "./ThemeProvider";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Toggle() {
  const { theme, setTheme } = useTheme();
  return (
    <button onClick={() => setTheme("light")} type="button">
      {theme}
    </button>
  );
}

describe("ThemeProvider in a browser that keeps nothing", () => {
  it("renders with the default theme and still switches it", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>,
    );

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("dark");
    act(() => button.click());
    expect(button.textContent).toBe("light");
  });
});
