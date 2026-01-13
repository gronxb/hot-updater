import type { RolloutStats } from "@hot-updater/plugin-core";
import { useQuery } from "@tanstack/solid-query";
import { BarChart3 } from "lucide-solid";
import { createSignal, Show } from "solid-js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export interface RolloutStatsDialogProps {
  bundleId: string;
}

export const RolloutStatsDialog = ({ bundleId }: RolloutStatsDialogProps) => {
  const [open, setOpen] = createSignal(false);

  const statsQuery = useQuery(() => ({
    queryKey: ["rollout-stats", bundleId],
    enabled: open(),
    queryFn: async (): Promise<RolloutStats> => {
      const res = await api.bundles[":bundleId"]["rollout-stats"].$get({
        param: { bundleId },
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch rollout stats: ${res.status}`);
      }
      return res.json();
    },
    retry: false,
  }));

  return (
    <AlertDialog open={open()} onOpenChange={setOpen}>
      <AlertDialogTrigger
        as={Button}
        variant="outline"
        size="sm"
        class="gap-2 w-full"
      >
        <BarChart3 class="h-4 w-4" />
        Rollout Stats
      </AlertDialogTrigger>
      <AlertDialogContent class="max-w-md">
        <AlertDialogTitle>Rollout Statistics</AlertDialogTitle>
        <AlertDialogDescription>
          Deployment metrics for this bundle
        </AlertDialogDescription>

        <div class="mt-4">
          <Show when={statsQuery.isError}>
            <p class="text-sm text-red-500">Failed to load rollout stats.</p>
          </Show>

          <Show when={!statsQuery.isError}>
            <Show
              when={statsQuery.data}
              fallback={
                <div class="flex items-center justify-center h-32">
                  <div class="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                </div>
              }
            >
              {(stats) => (
                <div class="space-y-4">
                  <div class="grid grid-cols-2 gap-4">
                    <div class="bg-muted p-4 rounded-lg">
                      <p class="text-sm text-muted-foreground">Total Devices</p>
                      <p class="text-2xl font-bold">{stats().totalDevices}</p>
                    </div>
                    <div class="bg-green-100 p-4 rounded-lg">
                      <p class="text-sm text-green-700">Success Rate</p>
                      <p class="text-2xl font-bold text-green-700">
                        {stats().successRate}%
                      </p>
                    </div>
                  </div>

                  <div class="space-y-2">
                    <div class="flex justify-between items-center">
                      <span class="text-sm text-muted-foreground">
                        Promoted
                      </span>
                      <span class="font-semibold text-green-600">
                        {stats().promotedCount}
                      </span>
                    </div>
                    <div class="flex justify-between items-center">
                      <span class="text-sm text-muted-foreground">
                        Recovered
                      </span>
                      <span class="font-semibold text-orange-600">
                        {stats().recoveredCount}
                      </span>
                    </div>
                  </div>

                  <div class="w-full bg-gray-200 rounded-full h-4">
                    <div
                      class="bg-green-600 h-4 rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, Math.max(0, stats().successRate))}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </Show>
          </Show>
        </div>

        <div class="flex justify-end mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => statsQuery.refetch()}
            disabled={statsQuery.isFetching}
          >
            Refresh
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
};
