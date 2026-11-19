import {defineConfig} from '@playwright/test';
const external=process.env.PANDO_PUBLIC_URL||process.env.PANDOLAB_TEST_BASE_URL;
const baseURL=external||`http://127.0.0.1:${Number(process.env.PANDOLAB_TEST_PORT||4187)}`;
export default defineConfig({
  outputDir:process.env.PANDO_PERF_CAPTURE==='1'?`test-results/performance/${['baseline','baseline-retry','candidate','candidate-retry'].includes(process.env.PANDO_PERF_LABEL)?process.env.PANDO_PERF_LABEL:'candidate'}`:'test-results/viewer',
  testDir:'./tests/browser',testMatch:process.env.PANDO_PERF_CAPTURE==='1'?['viewer.spec.mjs','performance.spec.mjs']:'viewer.spec.mjs',fullyParallel:false,workers:1,
  timeout:120_000,expect:{timeout:15_000},reporter:[['list']],
  use:{baseURL,browserName:'chromium',channel:process.env.PANDOLAB_BROWSER_CHANNEL||undefined,
    launchOptions:{executablePath:process.env.PANDOLAB_BROWSER_EXECUTABLE||undefined,
      args:process.platform==='win32'?['--use-angle=d3d11']:[]},
    trace:'off',screenshot:'off'},
  webServer:external?undefined:{command:`"${process.execPath}" tests/browser/server.mjs`,url:baseURL,
    reuseExistingServer:false,timeout:120_000},
});
