// End-to-end tests drive the real Electron app (see tests/helpers.mjs).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // each test launches its own copy of the app
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
});
