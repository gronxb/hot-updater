import { jsx as _jsx } from "react/jsx-runtime";
import { StatusMessage } from "@inkjs/ui";
import { Box, Static, useApp } from "ink";
import { useCallback, useState } from "react";
export const useLog = () => {
    const { exit } = useApp();
    const [items, setItems] = useState([]);
    const log = {
        success: (message) => {
            setItems((items) => [...items, { variant: "success", message }]);
        },
        error: (message) => {
            setItems((items) => [...items, { variant: "error", message }]);
            exit(new Error(message));
        },
        info: (message) => {
            setItems((items) => [...items, { variant: "info", message }]);
        },
    };
    const StaticLogs = useCallback(() => {
        return (_jsx(Static, { items: items, children: ({ variant, message }, index) => {
                switch (variant) {
                    default: {
                        return (_jsx(StatusMessage, { variant: variant, children: message }, index));
                    }
                }
            } }));
    }, [items]);
    const Logs = useCallback(() => {
        return (_jsx(Box, { flexDirection: "column", children: items.map(({ variant, message }, index) => {
                return (_jsx(StatusMessage, { variant: variant, children: message }, index));
            }) }));
    }, [items]);
    return {
        /** Component */
        StaticLogs,
        Logs,
        /** Methods */
        log,
    };
};
