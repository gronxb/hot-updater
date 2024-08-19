import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// import { getCwd } from "@/cwd.js";
// import { loadConfig } from "@/utils/loadConfig.js";
// import * as p from "@clack/prompts";
// import type { Platform } from "@hot-updater/internal";
// export interface PruneOptions {
//   platform: Platform;
// }
// export const prune = async (options: PruneOptions) => {
//   const s = p.spinner();
//   const { deploy } = await loadConfig();
//   const cwd = getCwd();
//   const deployPlugin = deploy({
//     cwd,
//     spinner: s,
//   });
//   s.start("Checking existing updates");
//   const updateSources = await deployPlugin.getUpdateJson();
//   const activeSources = updateSources.filter((source) => source.enabled);
//   const inactiveSources = updateSources.filter((source) => !source.enabled);
//   if (inactiveSources.length === 0) {
//     s.stop("No inactive versions found", -1);
//     return;
//   }
//   s.message("Pruning updates");
//   await deployPlugin.setUpdateJson(activeSources);
//   await deployPlugin.commitUpdateJson();
//   for (const source of inactiveSources) {
//     const key = await deployPlugin.deleteBundle(
//       options.platform,
//       source.bundleVersion,
//     );
//     p.log.info(`deleting: ${key}`);
//   }
//   s.stop("Done");
// };
import { Banner } from "../components/Banner.js";
import { SelectInput } from "../components/SelectInput.js";
import { getCwd } from "../cwd.js";
import { useLog } from "../hooks/useLog.js";
import { useSpinner } from "../hooks/useSpinner.js";
import { useUpdateSources } from "../hooks/useUpdateSources.js";
import { loadConfig } from "../utils/loadConfig.js";
import { StatusMessage } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { option } from "pastel";
import { z } from "zod";
export const options = z.object({
    platform: z.union([z.literal("ios"), z.literal("android")]).describe(option({
        description: "specify the platform",
        alias: "p",
    })),
});
const { deploy } = await loadConfig();
const cwd = getCwd();
const deployPlugin = deploy({
    cwd,
});
export default function Prune({ options }) {
    const { updateSources } = useUpdateSources({
        deployPlugin,
        platform: options.platform,
    });
    const { StaticLogs, log } = useLog();
    const { SpinnerLog, spinner } = useSpinner();
    const { exit } = useApp();
    const inactiveSources = updateSources.filter((source) => !source.enabled);
    const handlePrune = async () => {
        const activeSources = updateSources.filter((source) => source.enabled);
        const inactiveSources = updateSources.filter((source) => !source.enabled);
        if (inactiveSources.length === 0) {
            log.error("No inactive versions found");
            exit();
            return;
        }
        spinner.message("Pruning updates");
        await deployPlugin.setUpdateJson(activeSources);
        await deployPlugin.commitUpdateJson();
        for (const source of inactiveSources) {
            const key = await deployPlugin.deleteBundle(options.platform, source.bundleVersion);
            log.success(`deleting: ${key}`);
        }
    };
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Banner, {}), _jsxs(StatusMessage, { variant: "info", children: ["Found ", inactiveSources.length, " inactive bundles. Do you want to delete them?"] }), _jsx(SelectInput, { indicatorComponent: ({ isSelected }) => isSelected ? _jsx(Text, { children: "[*] " }) : _jsx(Text, { children: "[ ] " }), items: [
                    {
                        label: "Yes",
                        value: true,
                    },
                    {
                        label: "No",
                        value: false,
                    },
                ], onSelect: (item) => {
                    if (!item.value) {
                        exit();
                    }
                    handlePrune();
                } }), _jsx(StaticLogs, {}), _jsx(SpinnerLog, {})] }));
}
