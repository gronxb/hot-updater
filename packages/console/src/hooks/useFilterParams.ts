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
    void navigate({
      to: "/",
      search: {
        channel:
          newFilters.channel !== undefined
            ? newFilters.channel
            : filters.channel,
        platform:
          newFilters.platform !== undefined
            ? newFilters.platform
            : filters.platform,
        // Reset offset when changing filters
        offset:
          newFilters.channel !== undefined || newFilters.platform !== undefined
            ? "0"
            : newFilters.offset !== undefined
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
