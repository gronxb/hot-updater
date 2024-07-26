import { StatusMessage } from "@inkjs/ui";
import { Box, Static, useApp } from "ink";
import { useCallback, useState } from "react";

export const useLog = () => {
  const { exit } = useApp();

  const [items, setItems] = useState<
    {
      variant: "success" | "error" | "info";
      message: string;
    }[]
  >([]);

  const log = {
    success: (message: string) => {
      setItems((items) => [...items, { variant: "success", message }]);
    },
    error: (message: string) => {
      setItems((items) => [...items, { variant: "error", message }]);
      exit(new Error(message));
    },
    info: (message: string) => {
      setItems((items) => [...items, { variant: "info", message }]);
    },
  };

  const StaticLogs = useCallback(() => {
    return (
      <Static items={items}>
        {({ variant, message }, index) => {
          switch (variant) {
            default: {
              return (
                <StatusMessage variant={variant} key={index}>
                  {message}
                </StatusMessage>
              );
            }
          }
        }}
      </Static>
    );
  }, [items]);

  const Logs = useCallback(() => {
    return (
      <Box flexDirection="column">
        {items.map(({ variant, message }, index) => {
          return (
            <StatusMessage variant={variant} key={index}>
              {message}
            </StatusMessage>
          );
        })}
      </Box>
    );
  }, [items]);

  return {
    /** Component */
    StaticLogs,
    Logs,

    /** Methods */
    log,
  };
};
