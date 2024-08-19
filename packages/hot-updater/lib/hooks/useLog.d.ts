export declare const useLog: () => {
    /** Component */
    StaticLogs: () => import("react/jsx-runtime").JSX.Element;
    Logs: () => import("react/jsx-runtime").JSX.Element;
    /** Methods */
    log: {
        success: (message: string) => void;
        error: (message: string) => void;
        info: (message: string) => void;
    };
};
