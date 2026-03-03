import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: process.env.BASE_URL || "https://kbo-everyday.vercel.app",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  reporter: [["list"], ["json", { outputFile: "/tmp/e2e-results.json" }]],
  projects: [
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      },
    },
  ],
});
