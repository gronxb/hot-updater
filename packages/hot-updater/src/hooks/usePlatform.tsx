import type { Platform } from "@hot-updater/plugin-core";
import { Select } from "@inkjs/ui";
import { useState } from "react";

export interface PlatformSelectProps {
  onNext?: (platform: Platform) => void;
}

export const usePlatform = (initialPlatform: Platform | undefined) => {
  const [platform, setPlatform] = useState(initialPlatform);

  const PlatformSelect = ({ onNext }: PlatformSelectProps) => {
    return (
      <Select
        options={[
          {
            label: "ios",
            value: "ios",
          },
          {
            label: "android",
            value: "android",
          },
        ]}
        defaultValue={platform}
        isDisabled={Boolean(platform)}
        onChange={(newValue) => {
          setPlatform(newValue as Platform);
          onNext?.(newValue as Platform);
        }}
      />
    );
  };

  return { platform, PlatformSelect };
};
