import { jsx as _jsx } from "react/jsx-runtime";
import { formatDateTimeFromBundleVersion } from "../utils/formatDate.js";
import { Text } from "ink";
import { Table } from "./Table.js";
export const BundleInfoTable = ({ source, renders, widths, }) => {
    return (_jsx(Table, { data: [
            {
                createdAt: renders?.createdAt?.() ?? (_jsx(Text, { children: formatDateTimeFromBundleVersion(String(source.bundleVersion)) })),
                platform: renders?.platform?.() ?? _jsx(Text, { children: source.platform }),
                description: renders?.description?.() ?? (_jsx(Text, { children: source.description || "-" })),
                forceUpdate: renders?.forceUpdate?.() ?? (_jsx(Text, { children: source.forceUpdate ? "O" : "X" })),
                active: renders?.active?.() ??
                    (source.enabled ? (_jsx(Text, { color: "green", children: "ACTIVE" })) : (_jsx(Text, { color: "red", children: "INACTIVE" }))),
            },
        ], widths: {
            createdAt: 25,
            platform: 15,
            description: (source.description?.length ?? 0) + 15,
            forceUpdate: 15,
            active: 15,
            ...widths,
        }, headers: {
            createdAt: _jsx(Text, { color: "blue", children: "createdAt" }),
            platform: _jsx(Text, { color: "blue", children: "platform" }),
            description: _jsx(Text, { color: "blue", children: "description" }),
            forceUpdate: _jsx(Text, { color: "blue", children: "forceUpdate" }),
            active: _jsx(Text, { color: "blue", children: "active" }),
        } }));
};
