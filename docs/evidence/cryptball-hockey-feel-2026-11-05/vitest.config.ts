import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['docs/evidence/cryptball-hockey-feel-2026-11-05/baseline.test.ts'],environment:'node',maxWorkers:1}});
