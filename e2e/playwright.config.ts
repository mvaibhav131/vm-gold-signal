import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

// 05_UI_Spec section 9.1: DOM and accessibility assertions only. Screenshots, video and traces stay off.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: { baseURL, screenshot: 'off', video: 'off', trace: 'off' },
  projects: [
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @vmgs/web preview',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
