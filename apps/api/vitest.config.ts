import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
  plugins: [
    // Vitest transforms with esbuild, which does not emit decorator metadata.
    // Without SWC here, Nest's DI container cannot resolve constructor
    // parameters and every Test.createTestingModule() call fails to inject.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
