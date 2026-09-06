import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,

    /**
     * `threads`, not the `forks` default.
     *
     * On this repository the default pool never gets a worker up:
     * "[vitest-pool]: Failed to start forks worker ... Timeout waiting for
     * worker to respond", after 60 seconds, for any file. The error path in the
     * stack shows the project directory URL-encoded (`Cinderpaw%20Agent`), so
     * the space in the checkout path is the likely cause. Whatever the cause,
     * `npx vitest run` out of the box does not work here, which means the next
     * person to clone this — or CI on a runner whose workspace has a space in
     * it — meets a hang rather than a test suite.
     *
     * Pinned rather than left to the default so nobody has to know.
     */
    pool: 'threads',

    server: {
      deps: {
        /**
         * Radix ships CJS and ESM side by side, and under parallel workers the
         * two get resolved inconsistently: one worker imports the CJS build and
         * fails with `Named export 'useLayoutEffect' not found. The requested
         * module 'react' is a CommonJS module`, from `components/ui/popover.tsx`.
         * It is intermittent — ControlsPopover.test.tsx failed once in a full
         * run on 2026-09-06 and passed alone and on the next run — which is the
         * worst shape a CI failure can have: it lands on whoever pushed next and
         * looks like their fault.
         *
         * Inlining makes Vite transform these itself, so every worker sees the
         * same module in the same form.
         */
        inline: [/@radix-ui\//],
      },
    },
  },
});
