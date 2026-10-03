import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5173";
const pbURL = process.env.E2E_PB_URL || "http://127.0.0.1:8091";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    // Local runs may reuse an existing Chrome (e.g. puppeteer's) instead of downloading one.
    ...(process.env.E2E_CHROME ? { launchOptions: { executablePath: process.env.E2E_CHROME } } : {}),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Video needs Playwright's ffmpeg; local runs with a reused Chrome may not have it.
    video: process.env.E2E_CHROME ? "off" : "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
      },
    },
    {
      name: "chromium-desktop",
      use: { browserName: "chromium", viewport: { width: 1366, height: 768 } },
    },
    {
      name: "viewport-320",
      testMatch: /viewport\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 320, height: 700 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "viewport-360",
      testMatch: /viewport\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 360, height: 800 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "viewport-430",
      testMatch: /viewport\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 430, height: 932 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "viewport-tablet",
      testMatch: /viewport\.spec\.ts/,
      use: { browserName: "chromium", viewport: { width: 768, height: 1024 } },
    },
    // Optional: set E2E_FIREFOX=1 after `npx playwright install firefox`
    ...(process.env.E2E_FIREFOX === "1"
      ? [
          {
            name: "firefox-smoke",
            testMatch: /auth\.spec\.ts|viewport\.spec\.ts/,
            use: {
              ...devices["Desktop Firefox"],
              viewport: { width: 1366, height: 768 },
            },
          },
        ]
      : []),
  ],
  metadata: { pbURL },
});
