import { jsx as _jsx } from "react/jsx-runtime";
import { Spinner, StatusMessage } from "@inkjs/ui";
import { useApp } from "ink";
import { useCallback, useState } from "react";
export const useSpinner = () => {
    const { exit } = useApp();
    const [data, setData] = useState({
        status: "idle",
        message: "",
    });
    const spinner = {
        message: (message) => {
            setData({ status: "loading", message });
        },
        error: (message) => {
            setData({ status: "error", message });
            exit(new Error(message));
        },
        done: (message) => {
            setData({ status: "done", message });
        },
    };
    const SpinnerLog = useCallback(() => {
        switch (data.status) {
            case "error":
                return _jsx(StatusMessage, { variant: "error", children: data.message });
            case "done":
                return _jsx(StatusMessage, { variant: "success", children: data.message });
            case "idle":
                return null;
            default:
                return _jsx(Spinner, { label: data.message });
        }
    }, [data]);
    return {
        /** Component */
        SpinnerLog,
        /** Methods */
        spinner,
    };
};
