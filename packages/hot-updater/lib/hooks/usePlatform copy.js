import { jsx as _jsx } from "react/jsx-runtime";
import { Select } from "@inkjs/ui";
import { useState } from "react";
export const usePlatform = (initialPlatform) => {
    const [platform, setPlatform] = useState(initialPlatform);
    const PlatformSelect = ({ onNext }) => {
        return (_jsx(Select, { options: [
                {
                    label: "ios",
                    value: "ios",
                },
                {
                    label: "android",
                    value: "android",
                },
            ], defaultValue: platform, isDisabled: Boolean(platform), onChange: (newValue) => {
                setPlatform(newValue);
                onNext?.(newValue);
            } }));
    };
    return { platform, PlatformSelect };
};
