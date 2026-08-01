"use client";

// Shared recharts tooltip for stacked bar charts in /admin.
// Shows each stacked series plus the total, so admins don't add values by hand.
// The total row is hidden when only one series is present (it would just repeat
// the single value).

type TooltipEntry = { name?: string; value?: number; color?: string };

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

export default function StackedTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const total = payload.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
  return (
    <div
      style={{
        background: "#1C1C1F",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: 12,
      }}
    >
      <p style={{ color: "#8E8E93", marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color, margin: 0 }}>
          {p.name} : {fmt(Number(p.value) || 0)}
        </p>
      ))}
      {payload.length > 1 && (
        <p
          style={{
            color: "#FFFFFF",
            margin: 0,
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid rgba(255,255,255,0.1)",
            fontWeight: 600,
          }}
        >
          합계 : {fmt(total)}
        </p>
      )}
    </div>
  );
}
