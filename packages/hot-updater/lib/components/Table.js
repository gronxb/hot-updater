import { Fragment as _Fragment, jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from "ink";
import React, { useMemo } from "react";
export const Table = ({ data, headers, widths }) => {
    const columns = useMemo(() => Object.entries(widths).map(([key, width]) => ({
        key,
        width,
    })), [widths]);
    return (_jsxs(Box, { flexDirection: "column", children: [renderHeaderSeparators(columns), headers && (_jsxs(_Fragment, { children: [renderRow(headers, columns), renderRowSeparators(columns)] })), data.map((row, index) => (_jsxs(React.Fragment, { children: [index !== 0 && renderRowSeparators(columns), renderRow(row, columns)] }, `row-${index}`))), renderFooterSeparators(columns)] }));
};
// Helper function to render a row with separators
function renderRow(row, columns) {
    return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { children: "\u2502" }), columns.map((column, index) => (_jsxs(React.Fragment, { children: [index !== 0 && _jsx(Text, { children: "\u2502" }), _jsx(Box, { width: column.width, justifyContent: "center", children: row[column.key] })] }, column.key))), _jsx(Text, { children: "\u2502" })] }));
}
function renderHeaderSeparators(columns) {
    return renderRowSeparators(columns, "┌", "┬", "┐");
}
function renderFooterSeparators(columns) {
    return renderRowSeparators(columns, "└", "┴", "┘");
}
function renderRowSeparators(columns, leftChar = "├", midChar = "┼", rightChar = "┤") {
    return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { children: leftChar }), columns.map((column, index) => (_jsxs(React.Fragment, { children: [_jsx(Text, { children: "─".repeat(column.width) }), index < columns.length - 1 ? (_jsx(Text, { children: midChar })) : (_jsx(Text, { children: rightChar }))] }, column.key)))] }));
}
