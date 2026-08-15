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

  it("resets pagination when the platform filter changes", () => {
    mockUseSearch.mockReturnValue({
      platform: "ios",
      page: 3,
      after: "bundle-020",
      before: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setFilters({ platform: "android" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/artifacts",
      search: {
        platform: "android",
        page: undefined,
        after: undefined,
        before: undefined,
        bundleId: undefined,
        expandedBundleId: undefined,
      },
    });
  });

  it("preserves omitted filters while allowing cursor params to be cleared", () => {
    mockUseSearch.mockReturnValue({
      platform: "android",
      page: 4,
      after: "bundle-020",
      before: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setFilters({ after: undefined });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/artifacts",
      search: {
        platform: "android",
        page: 4,
        after: undefined,
        before: undefined,
        bundleId: undefined,
        expandedBundleId: undefined,
      },
    });
  });

  it("sets bundleId in the URL and resets cursors when platform changes", () => {
    mockUseSearch.mockReturnValue({
      platform: "ios",
      page: 5,
      after: "bundle-040",
      before: undefined,
      bundleId: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setBundleId("bundle-123", { platform: "android" });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/artifacts",
      search: {
        platform: "android",
        page: undefined,
        after: undefined,
        before: undefined,
        bundleId: "bundle-123",
        expandedBundleId: undefined,
      },
      resetScroll: false,
    });
  });

  it("omits page 1 from the URL while keeping higher pages", () => {
    mockUseSearch.mockReturnValue({
      platform: "ios",
      page: 2,
      after: "bundle-040",
      before: undefined,
      bundleId: undefined,
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setFilters({
        page: 1,
        before: "bundle-020",
        after: undefined,
      });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/artifacts",
      search: {
        platform: "ios",
        page: undefined,
        after: undefined,
        before: "bundle-020",
        bundleId: undefined,
        expandedBundleId: undefined,
      },
    });
  });
});
