import { open } from "@tauri-apps/plugin-dialog";

import { trpc } from "@/lib/trpc";

import { processManager } from "@/lib/process-manager";
import { delay } from "@/utils/delay";
import { atom, useAtom } from "jotai";
import { toast } from "./use-toast";

const isConfigLoadingAtom = atom(false);

export const useConfigLoaded = () => {
  const utils = trpc.useUtils();

  const { data: isConfigLoaded } = trpc.isConfigLoaded.useQuery();
  const [isConfigLoading, setIsConfigLoading] = useAtom(isConfigLoadingAtom);

  const { mutate: setCwd } = trpc.setCwd.useMutation({
    onMutate: () => {
      setIsConfigLoading(true);
    },
    onSettled: () => {
      Promise.all([
        utils.cwd.invalidate(),
        utils.isConfigLoaded.invalidate(),
        utils.updateSources.invalidate(),
      ]).finally(() => {
        setIsConfigLoading(false);
      });
    },
  });

  const handleSelectDirectory = async () => {
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
  };

  const handleRefresh = () => {
    setIsConfigLoading(true);
    Promise.all([
      utils.cwd.refetch(),
      utils.updateSources.refetch(),
      utils.isConfigLoaded.refetch(),
      delay(400),
    ]).finally(() => {
      setIsConfigLoading(false);
    });
  };

  return {
    handleSelectDirectory,
    handleRefresh,
    isLoading: isConfigLoading,
    isLoaded: isConfigLoaded,
  };
};
