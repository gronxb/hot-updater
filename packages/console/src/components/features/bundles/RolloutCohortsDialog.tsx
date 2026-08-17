import {
  getNumericCohortRolloutPosition,
  NUMERIC_COHORT_SIZE,
  normalizeRolloutCohortCount,
} from "@hot-updater/core";
import { List } from "lucide-react";

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
import { useIsMobile } from "@/hooks/use-mobile";

interface RolloutCohortsDialogProps {
  readonly releaseId: string;
  readonly rolloutCohortCount: number | null | undefined;
  readonly targetCohorts?: readonly string[] | null | undefined;
}

export function RolloutCohortsDialog({
  releaseId,
  rolloutCohortCount,
  targetCohorts,
}: RolloutCohortsDialogProps) {
  const normalizedRolloutCount =
    normalizeRolloutCohortCount(rolloutCohortCount);
  const normalizedTargetCohorts = targetCohorts ?? [];
  const hasTargetCohorts = normalizedTargetCohorts.length > 0;
  const isPartialRollout =
    normalizedRolloutCount > 0 && normalizedRolloutCount < NUMERIC_COHORT_SIZE;
  const isMobile = useIsMobile();

  if (!isPartialRollout) {
    return null;
  }

  const rolloutCohorts = Array.from(
    { length: NUMERIC_COHORT_SIZE },
    (_, index) => index + 1,
  ).filter(
    (cohortValue) =>
      getNumericCohortRolloutPosition(releaseId, cohortValue) <
      normalizedRolloutCount,
  );
  const rolloutPercentage = (normalizedRolloutCount / 10).toFixed(1);
  const excludedCount = NUMERIC_COHORT_SIZE - rolloutCohorts.length;

  const dialogBody = (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Selected Cohorts</CardDescription>
            <CardTitle className="font-mono text-xl tabular-nums">
              {rolloutCohorts.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardDescription>Excluded Cohorts</CardDescription>
            <CardTitle className="font-mono text-xl tabular-nums">
              {excludedCount}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <CardHeader className="p-4">
            <CardDescription>Release ID</CardDescription>
            <CardTitle
              className="break-all font-mono text-xs leading-relaxed"
              translate="no"
            >
              {releaseId}
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
          <div className="max-h-[50vh] overflow-y-auto overscroll-contain rounded-lg border bg-muted/20 p-3 sm:max-h-[45vh]">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">
              {rolloutCohorts.map((cohortValue) => (
                <Badge
                  className="justify-center font-mono tabular-nums"
                  key={cohortValue}
                  variant="outline"
                >
                  {cohortValue}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {hasTargetCohorts ? (
        <Card>
          <CardHeader className="p-4 pb-3">
            <CardTitle className="text-sm">Target Cohorts</CardTitle>
            <CardDescription>
              These cohorts are included in addition to the numeric rollout.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/20 p-3">
              {normalizedTargetCohorts.map((cohort) => (
                <Badge
                  className="max-w-full font-mono"
                  key={cohort}
                  variant="secondary"
                >
                  <span className="truncate">{cohort}</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );

  return (
    <Dialog>
      <DialogTrigger
        render={<Button size="sm" type="button" variant="outline" />}
      >
        <List data-icon="inline-start" />
        Preview Cohorts
      </DialogTrigger>
      <DialogContent
        className={
          isMobile
            ? "top-0 left-0 h-dvh max-w-none translate-x-0 translate-y-0 rounded-none border-0 p-0"
            : "sm:max-w-3xl"
        }
      >
        {isMobile ? (
          <div className="flex h-full flex-col overflow-hidden">
            <DialogHeader className="shrink-0 border-b border-border/70 px-4 py-4">
              <DialogTitle>Rolled Out Cohorts</DialogTitle>
              <DialogDescription>
                {rolloutPercentage}% rollout currently targets{" "}
                {rolloutCohorts.length} of {NUMERIC_COHORT_SIZE} numeric
                cohorts. The selected set stays stable as rollout changes.
                {hasTargetCohorts
                  ? " Target Cohorts are added on top of this numeric rollout."
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
              {dialogBody}
            </div>
            <DialogFooter
              className="shrink-0 border-t border-border/70 px-4 py-3"
              showCloseButton
            />
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Rolled Out Cohorts</DialogTitle>
              <DialogDescription>
                {rolloutPercentage}% rollout currently targets{" "}
                {rolloutCohorts.length} of {NUMERIC_COHORT_SIZE} numeric
                cohorts. The selected set stays stable as rollout changes.
                {hasTargetCohorts
                  ? " Target Cohorts are added on top of this numeric rollout."
                  : ""}
              </DialogDescription>
            </DialogHeader>
            {dialogBody}
            <DialogFooter showCloseButton />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
