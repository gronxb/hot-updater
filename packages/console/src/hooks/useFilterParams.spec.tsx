import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFilterParams } from "./useFilterParams";

const { mockNavigate, mockUseSearch } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseSearch: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => mockUseSearch(),
}));

describe("useFilterParams", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockUseSearch.mockReset();
  });

  it("treats explicit undefined channel updates as clears", () => {
    mockUseSearch.mockReturnValue({
      channel: "stable",
      platform: "ios",
      after: "bundle-020",
      before: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setFilters({ channel: undefined });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/",
      search: {
        channel: undefined,
        platform: "ios",
        after: undefined,
        before: undefined,
        bundleId: undefined,
      },
    });
  });

  it("preserves omitted filters while allowing cursor params to be cleared", () => {
    mockUseSearch.mockReturnValue({
      channel: "stable",
      platform: "android",
      after: "bundle-020",
      before: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setFilters({ after: undefined });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/",
      search: {
        channel: "stable",
        platform: "android",
        after: undefined,
        before: undefined,
        bundleId: undefined,
      },
    });
  });

  it("sets bundleId in the URL and resets cursors when the channel changes", () => {
    mockUseSearch.mockReturnValue({
      channel: "stable",
      platform: "ios",
      after: "bundle-040",
      before: undefined,
      bundleId: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setBundleId("bundle-123", { channel: "beta" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/",
      search: {
        channel: "beta",
        platform: "ios",
        after: undefined,
        before: undefined,
        bundleId: "bundle-123",
      },
    });
  });
});
