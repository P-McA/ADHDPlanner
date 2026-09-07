import nextJest from 'next/jest.js';

// next/jest wires up the SWC transform, CSS/asset mocks and path aliases so the
// test environment matches how Next actually compiles the app.
const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testMatch: ['<rootDir>/src/**/*.test.{ts,tsx}'],
};

export default createJestConfig(config);
