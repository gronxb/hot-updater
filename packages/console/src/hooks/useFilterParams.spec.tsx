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
      offset: "20",
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
        offset: "0",
        bundleId: undefined,
      },
    });
  });

  it("preserves omitted filters while allowing offset to be cleared", () => {
    mockUseSearch.mockReturnValue({
      channel: "stable",
      platform: "android",
      offset: "20",
    });

    const { result } = renderHook(() => useFilterParams());

    act(() => {
      result.current.setFilters({ offset: undefined });
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/",
      search: {
        channel: "stable",
        platform: "android",
        offset: undefined,
        bundleId: undefined,
      },
    });
  });

  it("sets bundleId in the URL and resets offset when the channel changes", () => {
    mockUseSearch.mockReturnValue({
      channel: "stable",
      platform: "ios",
      offset: "40",
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
        offset: "0",
        bundleId: "bundle-123",
      },
    });
  });
});
