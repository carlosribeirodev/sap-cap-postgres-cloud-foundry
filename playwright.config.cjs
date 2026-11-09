const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/approuter', workers: 1,
  projects: [
    { name: 'requests' },
    { name: 'assets', testDir: './test/assets-ui', use: { baseURL: 'http://127.0.0.1:4174' } }
  ],
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', launchOptions: process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {} },
  webServer: [
    { command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory apps/approuter/web', url: 'http://127.0.0.1:4173', reuseExistingServer: false },
    { command: 'python3 -m http.server 4174 --bind 127.0.0.1 --directory apps/assets-approuter/web', url: 'http://127.0.0.1:4174', reuseExistingServer: false }
  ]
});
