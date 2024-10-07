import { Button } from "@/components/ui/button";

import { open } from "@tauri-apps/plugin-dialog";

import { toast } from "@/hooks/use-toast";
import { processManager } from "@/lib/process-manager";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { RefreshCcw } from "lucide-react";
import { Link } from "wouter";
import { columns } from "./update-sources/columns";
import { DataTable } from "./update-sources/data-table";

export const HomePage = () => {
  const {
    data,
    isLoading,
    error: updateSourcesError,
  } = trpc.updateSources.useQuery();
  const utils = trpc.useUtils();

  const { data: cwd } = trpc.cwd.useQuery();
  const { data: isConfigLoaded } = trpc.isConfigLoaded.useQuery();

  const { mutate: setCwd, error } = trpc.setCwd.useMutation({
    onMutate: () => {
      utils.cwd.invalidate();
      utils.isConfigLoaded.invalidate();
      utils.updateSources.invalidate();
    },
  });

  return (
    <div className="w-full space-y-2.5">
      <p>{JSON.stringify(error)}</p>
      <p>{JSON.stringify(updateSourcesError)}</p>
      <p>cwd: {cwd}</p>
      <p>isConfigLoaded: {isConfigLoaded ? "true" : "false"}</p>

      <Button
        onClick={() => {
          utils.cwd.refetch();
          utils.updateSources.refetch();
          utils.isConfigLoaded.refetch();
        }}
        variant="outline"
        size="icon"
      >
        <RefreshCcw className={cn("h-4 w-4", isLoading && "animate-spin")} />
      </Button>

      <Button
        onClick={async () => {
          const cwd = await open({
            directory: true,
            multiple: false,
            title: "Select Working Directory",
          });
          if (!cwd) {
            toast({
              title: "No directory selected",
            });
            return;
          }
          await processManager.setCwd(cwd);
          await setCwd({ cwd });
        }}
      >
        Open Dialog
      </Button>
      <Link href="/empty-config">Empty Config</Link>
      <DataTable columns={columns} data={data ?? []} />
    </div>
  );
};
