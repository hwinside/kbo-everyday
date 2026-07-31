import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 직관 통계 S2 대시보드: effect 안 동기 setState 금지를 명시적으로 검사한다.
  // (eslint-config-next 기본값에는 이 규칙이 꺼져 있어 venue-stats-s2 gate가 놓치게 된다.)
  {
    files: ["src/components/my/VenueStatsDashboard.tsx", "src/lib/venue-stats/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
