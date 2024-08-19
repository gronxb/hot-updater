import Table from "cli-table3";
import picocolors from "picocolors";
export const createTable = () => {
    const table = new Table({
        head: [
            "Platform",
            "Active",
            "Description",
            "Target App Version",
            "Bundle Version",
        ],
        style: { head: ["cyan"] },
    });
    const pushTable = (source) => {
        table.push([
            source.platform,
            source.enabled ? picocolors.green("true") : picocolors.red("false"),
            source.description || "-",
            source.targetVersion,
            source.bundleVersion,
        ]);
    };
    return { table, pushTable };
};
