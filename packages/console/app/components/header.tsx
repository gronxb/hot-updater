import { useConfigLoaded } from "@/hooks/use-config-loaded";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Check, RefreshCcw } from "lucide-react";
import { Fragment } from "react";
import { Button } from "./ui/button";

export const Header = () => {
  const { data: isConfigLoaded } = trpc.isConfigLoaded.useQuery();

  const { handleSelectDirectory, handleRefresh, isLoading } = useConfigLoaded();
  return (
    <header
      data-tauri-drag-region
      className="h-10 rounded-full px-4 flex justify-between items-center w-full"
    >
      <div className="flex-1" />

      <div className="flex flex-row gap-1">
        <Button size="sm" className="h-[22px]" onClick={handleSelectDirectory}>
          {isConfigLoaded ? (
            <Fragment>
              <Check size={14} className="mr-1" />
              <p>Config Loaded</p>
            </Fragment>
          ) : (
            "Select Directory"
          )}
        </Button>

        <Button onClick={handleRefresh} className="h-[22px]" size="icon">
          <RefreshCcw className={cn("h-3 w-3", isLoading && "animate-spin")} />
        </Button>
      </div>
    </header>
  );
};
