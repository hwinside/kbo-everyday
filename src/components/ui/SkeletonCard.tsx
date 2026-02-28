import { clsx } from "clsx";

interface SkeletonCardProps {
  className?: string;
  lines?: number;
}

export default function SkeletonCard({
  className,
  lines = 3,
}: SkeletonCardProps) {
  return (
    <div className={clsx("glass-card p-5 space-y-4", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={clsx(
            "skeleton h-4 rounded",
            i === 0 && "w-3/4",
            i === 1 && "w-full",
            i >= 2 && "w-1/2",
          )}
        />
      ))}
    </div>
  );
}

export function SkeletonLine({ className }: { className?: string }) {
  return <div className={clsx("skeleton h-4 rounded", className)} />;
}
