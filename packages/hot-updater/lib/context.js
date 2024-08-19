import { createContext, useContext } from "react";
export const CliContext = createContext(null);
export const useLoadConfig = () => {
    const cli = useContext(CliContext);
    if (!cli) {
        throw new Error("useLoadConfig must be used within a CliContext.Provider");
    }
    return cli.config;
};
export const useCwd = () => {
    const cli = useContext(CliContext);
    if (!cli) {
        throw new Error("useCwd must be used within a CliContext.Provider");
    }
    return cli.cwd;
};
