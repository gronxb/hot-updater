import {
  getNumericCohortRolloutPosition,
  NUMERIC_COHORT_SIZE,
  normalizeRolloutCohortCount,
} from "@hot-updater/core";
import { List } from "lucide-react";
import type { ComponentProps } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface RolloutCohortsDialogProps {
  bundleId: string;
  rolloutCohortCount: number | null | undefined;
  targetCohorts?: readonly string[] | null | undefined;
  triggerLabel?: string;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  triggerSize?: ComponentProps<typeof Button>["size"];
  triggerClassName?: string;
}

export function RolloutCohortsDialog({
  bundleId,
  rolloutCohortCount,
  targetCohorts,
  triggerLabel = "View Cohorts",
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
}: RolloutCohortsDialogProps) {
  const normalizedRolloutCount =
    normalizeRolloutCohortCount(rolloutCohortCount);
  const hasTargetCohortOverride = (targetCohorts?.length ?? 0) > 0;
  const isPartialRollout =
    normalizedRolloutCount > 0 &&
    normalizedRolloutCount < NUMERIC_COHORT_SIZE &&
    !hasTargetCohortOverride;

  if (!isPartialRollout) {
    return null;
  }

  const rolloutCohorts = Array.from(
    { length: NUMERIC_COHORT_SIZE },
    (_, index) => index + 1,
  ).filter(
    (cohortValue) =>
      getNumericCohortRolloutPosition(bundleId, cohortValue) <
      normalizedRolloutCount,
  );
  const rolloutPercentage = (normalizedRolloutCount / 10).toFixed(1);
  const excludedCount = NUMERIC_COHORT_SIZE - rolloutCohorts.length;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          onClick={(event) => event.stopPropagation()}
        >
          <List className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Rolled Out Cohorts</DialogTitle>
          <DialogDescription>
            {rolloutPercentage}% rollout currently targets{" "}
            {rolloutCohorts.length} of {NUMERIC_COHORT_SIZE} numeric cohorts.
            The selected set stays stable for this bundle as you expand or
            shrink rollout.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="p-4">
              <CardDescription>Selected Cohorts</CardDescription>
              <CardTitle className="font-mono text-xl">
                {rolloutCohorts.length}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-4">
              <CardDescription>Excluded Cohorts</CardDescription>
              <CardTitle className="font-mono text-xl">
                {excludedCount}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-4">
              <CardDescription>Bundle ID</CardDescription>
              <CardTitle className="font-mono text-xs break-all leading-relaxed">
                {bundleId}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle className="text-sm">Numeric Cohorts</CardTitle>
            <CardDescription>
              Listed in ascending order for readability.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border bg-muted/20 p-3">
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                {rolloutCohorts.map((cohortValue: number) => (
                  <Badge
                    key={cohortValue}
                    variant="outline"
                    className="justify-center font-mono"
                  >
                    {cohortValue}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
