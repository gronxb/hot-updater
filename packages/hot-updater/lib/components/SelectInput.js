import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { toRotated } from "../utils/toRotated.js";
import { Box, Text, useInput } from "ink";
import React, { useState, useCallback } from "react";
const ItemComponent = ({ isSelected = false, label }) => {
    return _jsx(Text, { color: isSelected ? "blue" : undefined, children: label });
};
export function SelectInput({ items = [], isFocused = true, initialIndex = 0, indicatorComponent, itemComponent = ItemComponent, limit: customLimit, onSelect, onHighlight, }) {
    const hasLimit = typeof customLimit === "number" && items.length > customLimit;
    const limit = hasLimit ? Math.min(customLimit, items.length) : items.length;
    const lastIndex = limit - 1;
    const [rotateIndex, setRotateIndex] = useState(initialIndex > lastIndex ? lastIndex - initialIndex : 0);
    const [selectedIndex, setSelectedIndex] = useState(initialIndex ? (initialIndex > lastIndex ? lastIndex : initialIndex) : 0);
    useInput(useCallback((input, key) => {
        if (input === "k" || key.upArrow) {
            const lastIndex = (hasLimit ? limit : items.length) - 1;
            const atFirstIndex = selectedIndex === 0;
            const nextIndex = hasLimit ? selectedIndex : lastIndex;
            const nextRotateIndex = atFirstIndex ? rotateIndex + 1 : rotateIndex;
            const nextSelectedIndex = atFirstIndex
                ? nextIndex
                : selectedIndex - 1;
            setRotateIndex(nextRotateIndex);
            setSelectedIndex(Math.max(nextSelectedIndex, 0));
            const slicedItems = hasLimit
                ? toRotated(items, nextRotateIndex).slice(0, limit)
                : items;
            if (typeof onHighlight === "function" &&
                slicedItems[nextSelectedIndex]) {
                onHighlight(slicedItems[nextSelectedIndex]);
            }
        }
        if (input === "j" || key.downArrow) {
            const atLastIndex = selectedIndex === (hasLimit ? limit : items.length) - 1;
            const nextIndex = hasLimit ? selectedIndex : 0;
            const nextRotateIndex = atLastIndex ? rotateIndex - 1 : rotateIndex;
            const nextSelectedIndex = atLastIndex ? nextIndex : selectedIndex + 1;
            setRotateIndex(nextRotateIndex);
            setSelectedIndex(nextSelectedIndex);
            const slicedItems = hasLimit
                ? toRotated(items, nextRotateIndex).slice(0, limit)
                : items;
            if (typeof onHighlight === "function") {
                onHighlight(slicedItems[nextSelectedIndex]);
            }
        }
        if (key.return) {
            const slicedItems = hasLimit
                ? toRotated(items, rotateIndex).slice(0, limit)
                : items;
            if (typeof onSelect === "function") {
                onSelect(slicedItems[selectedIndex]);
            }
        }
    }, [
        hasLimit,
        limit,
        rotateIndex,
        selectedIndex,
        items,
        onSelect,
        onHighlight,
    ]), { isActive: isFocused });
    const slicedItems = hasLimit
        ? toRotated(items, rotateIndex).slice(0, limit)
        : items;
    return (_jsx(Box, { flexDirection: "column", children: slicedItems.map((item, index) => {
            const isSelected = index === selectedIndex;
            return (_jsxs(Box, { children: [React.createElement(indicatorComponent, { isSelected }), React.createElement(itemComponent, { ...item, isSelected })] }, item.key ?? index));
        }) }));
}
