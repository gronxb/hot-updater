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
export default function List({ options }) {
    const { updateSources } = useUpdateSources({
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
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Banner, {}), _jsxs(StatusMessage, { variant: "info", children: ["List (", updateSources.length, ")"] }), _jsx(SelectInput, { indicatorComponent: ({ isSelected }) => isSelected ? _jsx(Text, { children: "[*] " }) : _jsx(Text, { children: "[ ] " }), initialIndex: updateSources.findIndex((source) => source === highlightSource) ?? 0, isFocused: true, items: updateSources.map((source) => {
                    return {
                        label: `${source.bundleVersion} (${source.platform})`,
                        value: source,
                        key: source.bundleVersion,
                    };
                }), onHighlight: (item) => setHighlightSource(item.value) }), highlightSource ? (_jsxs(Fragment, { children: [_jsx(Text, { color: "gray", children: "Current" }), _jsx(BundleInfoTable, { source: highlightSource })] })) : null] }));
}
