import { Button } from "@/components/ui/button";
import { useConfigLoaded } from "@/hooks/use-config-loaded";
import { cn } from "@/lib/utils";
import { RefreshCcw } from "lucide-react";
import { Redirect } from "wouter";

export const EmptyConfigPage = () => {
  const { handleSelectDirectory, isLoading, isLoaded } = useConfigLoaded();

  if (isLoaded) {
    return <Redirect to="/" />;
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen-without-header">
      <div className="text-lg font-bold">No configuration found</div>
      <div className="text-sm text-gray-500">
        Please create a new configuration or import an existing one.
      </div>

      <Button className="mt-4" onClick={handleSelectDirectory}>
        {isLoading ? (
          <RefreshCcw className={"h-3 w-3 mr-2 animate-spin"} />
        ) : null}
        Select Directory
      </Button>
    </div>
  );
};
