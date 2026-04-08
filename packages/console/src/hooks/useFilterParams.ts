import { useNavigate, useSearch } from "@tanstack/react-router";

export interface BundleFilters {
  channel?: string;
  platform?: "ios" | "android";
  after?: string;
  before?: string;
}

interface BundleSearchParams {
  channel: string | undefined;
  platform: "ios" | "android" | undefined;
  after: string | undefined;
  before: string | undefined;
  bundleId: string | undefined;
}

export function useFilterParams() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();

  const filters: BundleFilters = {
    channel: search.channel as string | undefined,
    platform: search.platform as "ios" | "android" | undefined,
    after: search.after as string | undefined,
    before: search.before as string | undefined,
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
    const hasAfter = Object.hasOwn(newFilters, "after");
    const hasBefore = Object.hasOwn(newFilters, "before");
    const shouldResetPagination = hasChannel || hasPlatform;

    return {
      channel: hasChannel ? newFilters.channel : filters.channel,
      platform: hasPlatform ? newFilters.platform : filters.platform,
      after: shouldResetPagination
        ? undefined
        : hasAfter
          ? newFilters.after
          : filters.after,
      before: shouldResetPagination
        ? undefined
        : hasBefore
          ? newFilters.before
          : filters.before,
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
      after: undefined,
      before: undefined,
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
