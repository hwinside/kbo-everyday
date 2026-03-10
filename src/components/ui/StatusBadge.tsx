export default function StatusBadge({ status, inning }: { status: string; inning: string | null }) {
  if (status === "live") {
    return (
      <span className="flex items-center gap-1 text-sm font-semibold text-accent-green">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-green animate-pulse" />
        {inning}
      </span>
    );
  }
  if (status === "final") {
    return <span className="text-sm text-text-secondary">종료</span>;
  }
  return <span className="text-sm text-text-secondary">예정</span>;
}
