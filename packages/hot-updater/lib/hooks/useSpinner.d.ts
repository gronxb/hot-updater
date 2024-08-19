export declare const useSpinner: () => {
    /** Component */
    SpinnerLog: () => import("react/jsx-runtime").JSX.Element | null;
    /** Methods */
    spinner: {
        message: (message: string) => void;
        error: (message: string) => void;
        done: (message: string) => void;
    };
};
