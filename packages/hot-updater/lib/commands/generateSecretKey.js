import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import crypto from "crypto";
import { Box, Text } from "ink";
import { useMemo } from "react";
export default function GenerateSecretKey() {
    const secretKey = useMemo(() => crypto.randomBytes(32).toString("hex"), []);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "green", children: "Secret Key: " }), _jsx(Text, { children: secretKey })] }));
}
