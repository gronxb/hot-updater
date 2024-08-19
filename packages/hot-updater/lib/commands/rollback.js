import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Banner } from "../components/Banner.js";
import { BundleInfoTable } from "../components/BundleInfoTable.js";
import { SelectInput } from "../components/SelectInput.js";
import { getCwd } from "../cwd.js";
import { useUpdateSources } from "../hooks/useUpdateSources.js";
import { loadConfig } from "../utils/loadConfig.js";
import { StatusMessage } from "@inkjs/ui";
import { Box, Text } from "ink";
import { option } from "pastel";
import { Fragment, useEffect, useState } from "react";
import { z } from "zod";
export const options = z.object({
    platform: z
        .union([z.literal("ios"), z.literal("android")])
        .describe(option({
        description: "specify the platform",
        alias: "p",
    }))
        .optional(),
    targetVersion: z
        .string()
        .describe(option({
        description: "specify the target version",
        alias: "t",
    }))
        .optional(),
});
const { deploy } = await loadConfig();
const cwd = getCwd();
const deployPlugin = deploy({
    cwd,
});
export default function Rollback({ options }) {
    const { updateSources, refresh } = useUpdateSources({
        deployPlugin,
        platform: options.platform,
        targetVersion: options.targetVersion,
    });
    const [highlightSource, setHighlightSource] = useState(null);
    useEffect(() => {
        if (updateSources.length > 0 && highlightSource === null) {
            setHighlightSource(updateSources?.[0] ?? null);
        }
    }, [updateSources]);
    const handleRollback = async (updateSource) => {
        const bundleVersion = updateSource.bundleVersion;
        await deployPlugin.updateUpdateJson(bundleVersion, {
            ...updateSource,
            enabled: !updateSource.enabled,
        });
        await deployPlugin.commitUpdateJson();
        const updateSources = await refresh();
        setHighlightSource(updateSources?.find((source) => source.bundleVersion === bundleVersion) ??
            null);
    };
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Banner, {}), _jsxs(StatusMessage, { variant: "info", children: ["Select the Version to Rollback (", updateSources.length, ")"] }), _jsx(SelectInput, { indicatorComponent: ({ isSelected }) => isSelected ? _jsx(Text, { children: "[*] " }) : _jsx(Text, { children: "[ ] " }), initialIndex: updateSources.findIndex((source) => source === highlightSource) ?? 0, isFocused: true, items: updateSources.map((source) => {
                    return {
                        label: `${source.bundleVersion} (${source.platform})`,
                        value: source,
                        key: source.bundleVersion,
                    };
                }), onHighlight: (item) => setHighlightSource(item.value), onSelect: (updateSource) => handleRollback(updateSource.value) }), highlightSource ? (_jsxs(Fragment, { children: [highlightSource.enabled ? (_jsx(Text, { color: "green", children: "Current: ACTIVE" })) : (_jsx(Text, { color: "red", children: "Current: INACTIVE" })), _jsx(Text, { color: "gray", children: "Expected" }), _jsx(BundleInfoTable, { source: highlightSource, widths: {
                            active: 30,
                        }, renders: {
                            active: () => highlightSource.enabled ? (_jsxs(Fragment, { children: [_jsx(Text, { color: "green", children: "ACTIVE" }), _jsx(Text, { color: "gray", children: " to " }), _jsx(Text, { color: "red", children: "INACTIVE" })] })) : (_jsxs(Fragment, { children: [_jsx(Text, { color: "red", children: "INACTIVE" }), _jsx(Text, { color: "gray", children: " to " }), _jsx(Text, { color: "green", children: "ACTIVE" })] })),
                        } })] })) : null] }));
}
