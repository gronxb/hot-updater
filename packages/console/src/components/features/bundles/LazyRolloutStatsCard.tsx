import { lazy, Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity } from "lucide-react";

const RolloutStatsCard = lazy(() =>
  import("./RolloutStatsCard").then((mod) => ({
    default: mod.RolloutStatsCard,
  })),
);

interface LazyRolloutStatsCardProps {
  bundleId: string;
}

function RolloutStatsCardSkeleton() {
  return (
    <Card variant="subtle">
      <CardHeader className="pb-[var(--spacing-component)]">
        <div className="flex items-center gap-[var(--spacing-element)]">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-[length:var(--text-h3)] font-semibold">
            Rollout Statistics
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-[var(--spacing-component)]">
          <Skeleton className="h-[200px] w-full" />
          <div className="space-y-[var(--spacing-element)]">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function LazyRolloutStatsCard({ bundleId }: LazyRolloutStatsCardProps) {
  return (
    <Suspense fallback={<RolloutStatsCardSkeleton />}>
      <RolloutStatsCard bundleId={bundleId} />
    </Suspense>
  );
}
