import type { Platform } from "@hot-updater/plugin-core";
import { useSearchParams } from "@solidjs/router";
import { createMemo } from "solid-js";

export const useFilter = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const bundleIdFilter = createMemo(
    () => (searchParams?.bundleId ?? null) as string | null,
  );
  const channelFilter = createMemo(
    () => (searchParams?.channel ?? null) as string | null,
  );
  const platformFilter = createMemo(
    () => (searchParams?.platform ?? null) as Platform | null,
  );

  return {
    bundleIdFilter,
    channelFilter,
    platformFilter,
    setBundleIdFilter: (bundleId: string | null) => {
      setSearchParams({
        bundleId: bundleId ?? undefined,
      });
    },
    setChannelFilter: (channel: string | null) => {
      setSearchParams({
        channel: channel ?? undefined,
      });
    },
    setPlatformFilter: (platform: Platform | null) => {
      setSearchParams({
        platform: platform ?? undefined,
      });
    },
  };
};
