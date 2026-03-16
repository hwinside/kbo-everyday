"use client";

interface DiamondProps {
  runner1b: boolean;
  runner2b: boolean;
  runner3b: boolean;
  teamColor?: string; // deprecated — kept for backward compat
}

/**
 * 다이아몬드 주자 표시 컴포넌트
 *
 * 규칙 (SSOT):
 * - 각 루는 항상 정확히 1개 상태: 빨강(주자) or 회색(빈루)
 * - none 금지, both 금지
 * - 1루=오른쪽, 2루=위, 3루=왼쪽 (홈 뒤에서 바라본 시점)
 */
export default function Diamond({
  runner1b,
  runner2b,
  runner3b,
}: DiamondProps) {
  const activeColor = "#E53935";
  const emptyFill = "var(--diamond-empty)";
  const emptyStroke = "var(--diamond-outline)";

  // 다이아몬드 꼭짓점 — 중심 (50, 42), 반경 28
  // 2루(top): (50, 14)
  // 1루(right): (78, 42)
  // 홈(bottom): (50, 70)
  // 3루(left): (22, 42)
  const bases = [
    { cx: 50, cy: 14, active: runner2b, label: "2루" },  // top
    { cx: 78, cy: 42, active: runner1b, label: "1루" },  // right
    { cx: 22, cy: 42, active: runner3b, label: "3루" },  // left
  ];

  return (
    <svg
      viewBox="0 0 100 84"
      className="w-[72px] h-[60px]"
      aria-label={`주자 상황: 1루 ${runner1b ? "있음" : "없음"}, 2루 ${runner2b ? "있음" : "없음"}, 3루 ${runner3b ? "있음" : "없음"}`}
    >
      {/* Diamond outline */}
      <path
        d="M50 14 L78 42 L50 70 L22 42 Z"
        fill="none"
        stroke={emptyStroke}
        strokeWidth="1.5"
      />

      {/* Base markers — 각 루에 항상 회색 or 빨강 1개 */}
      {bases.map(({ cx, cy, active, label }) => (
        <rect
          key={label}
          x={cx - 7}
          y={cy - 7}
          width={14}
          height={14}
          rx={2}
          transform={`rotate(45 ${cx} ${cy})`}
          fill={active ? activeColor : emptyFill}
          stroke={active ? activeColor : emptyStroke}
          strokeWidth={active ? 0 : 1.5}
        />
      ))}

      {/* Home plate */}
      <path
        d="M50 66 L54 70 L50 74 L46 70 Z"
        fill={emptyFill}
        opacity={0.5}
      />
    </svg>
  );
}
