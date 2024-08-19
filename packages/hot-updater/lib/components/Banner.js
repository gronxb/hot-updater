import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { version } from "../packageJson.js";
import { Box, Text } from "ink";
import Link from "ink-link";
export const Banner = () => {
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", alignSelf: "flex-start", children: [_jsxs(Text, { children: ["Hot Updater - React Native OTA Solution v", version] }), _jsx(Box, { justifyContent: "center", children: _jsx(Link, { url: "https://github.com/gronxb/hot-updater", children: _jsx(Text, { color: "cyan", children: "Github" }) }) })] }));
};
