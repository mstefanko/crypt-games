import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['docs/evidence/cryptball-hockey-feel-2026-11-05/workload.test.ts'],testTimeout:30000,environment:'node',maxWorkers:1}});
