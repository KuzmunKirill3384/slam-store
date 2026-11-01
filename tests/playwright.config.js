const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 20000,
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:8766/' },
  webServer: { command: 'python3 -m http.server 8766', cwd: '..', url: 'http://localhost:8766/', reuseExistingServer: true },
});
