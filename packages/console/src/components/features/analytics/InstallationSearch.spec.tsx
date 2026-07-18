import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallationSearch } from "./InstallationSearch";

const supported = { status: "supported", mode: "dedicated" } as const;

const useInstallationSearchQueryMock = vi.fn();

vi.mock("@/lib/api", () => ({
  useInstallationSearchQuery: (input: unknown, enabled: boolean) =>
    useInstallationSearchQueryMock(input, enabled),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    "aria-label": ariaLabel,
    children,
    search,
    to,
  }: {
    "aria-label"?: string;
    children: ReactNode;
    search: { query: string; installId: string };
    to: string;
  }) => (
    <a
      aria-label={ariaLabel}
      href={`${to}?query=${search.query}&installId=${search.installId}`}
    >
      {children}
    </a>
  ),
}));

const result = {
  installId: "install-1",
  username: "ada",
  userId: "user-1",
  lastKnownBundleId: "bundle-a",
  latestStatus: "UPDATE_APPLIED" as const,
  platform: "ios" as const,
  appVersion: "1.0.0",
  channel: "production",
  cohort: "cohort-a",
  receivedAtMs: Date.UTC(2026, 6, 15),
};

describe("InstallationSearch", () => {
  beforeEach(() => {
    useInstallationSearchQueryMock.mockReset();
    useInstallationSearchQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
  });

  afterEach(cleanup);

  it("does not request data before a query is submitted", () => {
    render(<InstallationSearch capability={supported} />);

    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Installation inspector",
      }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Enter a user ID or install ID to search received reports.",
      ),
    ).toBeDefined();
    expect(
      screen
        .getByRole("searchbox", { name: "User ID or install ID" })
        .getAttribute("placeholder"),
    ).toBe("Enter a user ID or install ID");
    expect(useInstallationSearchQueryMock).toHaveBeenCalledWith(
      { query: "", limit: 20, offset: 0 },
      false,
    );
  });

  it.each(["enter", "button"] as const)(
    "submits one trimmed search using %s",
    (method) => {
      render(<InstallationSearch capability={supported} />);
      const input = screen.getByRole("searchbox", {
        name: "User ID or install ID",
      });
      fireEvent.change(input, { target: { value: "  ada  " } });

      if (method === "enter") {
        fireEvent.submit(screen.getByRole("search"));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Search" }));
      }

      expect(useInstallationSearchQueryMock).toHaveBeenLastCalledWith(
        { query: "ada", limit: 20, offset: 0 },
        true,
      );
    },
  );

  it("renders identity, Last known bundle, metadata, and detail navigation", () => {
    useInstallationSearchQueryMock.mockReturnValue({
      data: {
        data: [result],
        pagination: { total: 1, limit: 20, offset: 0 },
      },
      error: null,
      isLoading: false,
    });

    render(<InstallationSearch capability={supported} initialQuery="ada" />);

    expect(screen.getByText("user-1")).toBeDefined();
    expect(screen.getByText("install-1")).toBeDefined();
    expect(screen.getAllByText("Last known bundle").length).toBeGreaterThan(0);
    expect(screen.getByText("bundle-a")).toBeDefined();
    expect(screen.getByText("iOS · production · 1.0.0")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: /open install-1/i })
        .getAttribute("href"),
    ).toBe("/installations?query=ada&installId=install-1");
  });

  it("falls back to install id when user identity is missing", () => {
    useInstallationSearchQueryMock.mockReturnValue({
      data: {
        data: [{ ...result, username: null, userId: null }],
        pagination: { total: 1, limit: 20, offset: 0 },
      },
      error: null,
      isLoading: false,
    });

    render(
      <InstallationSearch capability={supported} initialQuery="install-1" />,
    );

    expect(screen.getAllByText("install-1").length).toBeGreaterThan(0);
  });

  it("pages installation search results and resets on a new search", () => {
    // Given
    useInstallationSearchQueryMock.mockReturnValue({
      data: {
        data: [result],
        pagination: { total: 45, limit: 20, offset: 0 },
      },
      error: null,
      isLoading: false,
    });
    render(<InstallationSearch capability={supported} initialQuery="ada" />);

    // When
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Then
    expect(useInstallationSearchQueryMock).toHaveBeenLastCalledWith(
      { query: "ada", limit: 20, offset: 20 },
      true,
    );
    expect(
      screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled"),
    ).toBe(false);

    // When
    fireEvent.change(
      screen.getByRole("searchbox", { name: "User ID or install ID" }),
      { target: { value: "grace" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // Then
    expect(useInstallationSearchQueryMock).toHaveBeenLastCalledWith(
      { query: "grace", limit: 20, offset: 0 },
      true,
    );
  });

  it("distinguishes loading, empty, and error states", () => {
    const { rerender } = render(
      <InstallationSearch capability={supported} initialQuery="ada" />,
    );
    useInstallationSearchQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });
    rerender(<InstallationSearch capability={supported} initialQuery="ada" />);
    expect(screen.getByLabelText("Searching installations")).toBeDefined();

    useInstallationSearchQueryMock.mockReturnValue({
      data: { data: [], pagination: { total: 0, limit: 20, offset: 0 } },
      error: null,
      isLoading: false,
    });
    rerender(<InstallationSearch capability={supported} initialQuery="ada" />);
    expect(
      screen.getByText("No installations matched that search."),
    ).toBeDefined();

    useInstallationSearchQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Search request failed"),
      isLoading: false,
    });
    rerender(<InstallationSearch capability={supported} initialQuery="ada" />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Search request failed",
    );
  });
});
