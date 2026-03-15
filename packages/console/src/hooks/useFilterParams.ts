import { useNavigate, useSearch } from "@tanstack/react-router";

export interface BundleFilters {
  channel?: string;
  platform?: "ios" | "android";
  offset?: string;
}

interface BundleSearchParams {
  channel: string | undefined;
  platform: "ios" | "android" | undefined;
  offset: string | undefined;
  bundleId: string | undefined;
}

export function useFilterParams() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();

  const filters: BundleFilters = {
    channel: search.channel as string | undefined,
    platform: search.platform as "ios" | "android" | undefined,
    offset: search.offset as string | undefined,
  };
  const bundleId = search.bundleId as string | undefined;

  const navigateWithSearch = (nextSearch: BundleSearchParams) => {
    void navigate({
      to: "/",
      search: nextSearch,
    });
  };

  const getNextFilters = (newFilters: Partial<BundleFilters>) => {
    const hasChannel = Object.hasOwn(newFilters, "channel");
    const hasPlatform = Object.hasOwn(newFilters, "platform");
    const hasOffset = Object.hasOwn(newFilters, "offset");

    return {
      channel: hasChannel ? newFilters.channel : filters.channel,
      platform: hasPlatform ? newFilters.platform : filters.platform,
      // Reset offset when changing filters
      offset:
        hasChannel || hasPlatform
          ? "0"
          : hasOffset
            ? newFilters.offset
            : filters.offset,
    } satisfies BundleFilters;
  };

  const setFilters = (newFilters: Partial<BundleFilters>) => {
    navigateWithSearch({
      ...getNextFilters(newFilters),
      bundleId: undefined,
    });
  };

  const setBundleId = (
    nextBundleId: string | undefined,
    newFilters: Partial<BundleFilters> = {},
  ) => {
    navigateWithSearch({
      ...getNextFilters(newFilters),
      bundleId: nextBundleId,
    });
  };

  const resetFilters = () => {
    navigateWithSearch({
      channel: undefined,
      platform: undefined,
      offset: undefined,
      bundleId: undefined,
    });
  };

  return {
    filters,
    bundleId,
    setFilters,
    setBundleId,
    resetFilters,
  };
}
