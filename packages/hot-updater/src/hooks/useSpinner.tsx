import { Spinner, StatusMessage } from "@inkjs/ui";
import { useApp } from "ink";
import { useCallback, useState } from "react";

export const useSpinner = () => {
  const { exit } = useApp();

  const [data, setData] = useState<{
    status: "idle" | "loading" | "error" | "done";
    message: string;
  }>({
    status: "idle",
    message: "",
  });

  const spinner = {
    message: (message: string) => {
      setData({ status: "loading", message });
    },
    error: (message: string) => {
      setData({ status: "error", message });
      exit(new Error(message));
    },
    done: (message: string) => {
      setData({ status: "done", message });
    },
  };

  const SpinnerLog = useCallback(() => {
    switch (data.status) {
      case "error":
        return <StatusMessage variant="error">{data.message}</StatusMessage>;
      case "done":
        return <StatusMessage variant="success">{data.message}</StatusMessage>;
      case "idle":
        return null;
      default:
        return <Spinner label={data.message} />;
    }
  }, [data]);

  return {
    /** Component */
    SpinnerLog,

    /** Methods */
    spinner,
  };
};
