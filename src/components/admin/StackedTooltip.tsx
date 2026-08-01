"use client";

// Shared recharts tooltip for stacked bar charts in /admin.
// Shows each series plus the stacked total, so admins don't add values by hand.
//
// `showTotal` must be decided by the chart *configuration* (how many stacked
// series the chart declares), never by the hovered payload length. Recharts
// drops null/undefined entries from `payload` (filterNull), so a 2-series chart
// hovering a sparse day (e.g. downloads with iOS-only rows) yields a 1-entry
// payload — the exact day where a total is still meaningful.

type TooltipEntry = { name?: string; value?: number; color?: string };

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

export default function StackedTooltip({
  active,
  payload,
  label,
  showTotal,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  showTotal: boolean;
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
      {showTotal && (
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
