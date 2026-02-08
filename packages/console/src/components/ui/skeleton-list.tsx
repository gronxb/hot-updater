import { Skeleton } from "./skeleton";

interface SkeletonListProps {
  count: number;
  className?: string;
  containerClassName?: string;
}

/**
 * Reusable skeleton list component to avoid creating arrays inline on every render
 */
export function SkeletonList({
  count,
  className,
  containerClassName,
}: SkeletonListProps) {
  return (
    <div className={containerClassName}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={className} />
      ))}
    </div>
  );
}
