import { useNavigate, useSearch } from "@tanstack/react-router";

export interface BundleFilters {
  channel?: string;
  platform?: "ios" | "android";
  offset?: string;
}

export function useFilterParams() {
  const search = useSearch({ from: "/" });
  const navigate = useNavigate();

  const filters: BundleFilters = {
    channel: search.channel as string | undefined,
    platform: search.platform as "ios" | "android" | undefined,
    offset: search.offset as string | undefined,
  };

  const setFilters = (newFilters: Partial<BundleFilters>) => {
    const hasChannel = Object.hasOwn(newFilters, "channel");
    const hasPlatform = Object.hasOwn(newFilters, "platform");
    const hasOffset = Object.hasOwn(newFilters, "offset");

    void navigate({
      to: "/",
      search: {
        channel: hasChannel ? newFilters.channel : filters.channel,
        platform: hasPlatform ? newFilters.platform : filters.platform,
        // Reset offset when changing filters
        offset:
          hasChannel || hasPlatform
            ? "0"
            : hasOffset
              ? newFilters.offset
              : filters.offset,
        bundleId: undefined,
      },
    });
  };

  const resetFilters = () => {
    void navigate({
      to: "/",
      search: {
        channel: undefined,
        platform: undefined,
        offset: undefined,
        bundleId: undefined,
      },
    });
  };

  return {
    filters,
    setFilters,
    resetFilters,
  };
}
