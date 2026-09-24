/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  // Every test builds its own in-memory database, so specs are independent and can run in parallel workers.
  clearMocks: true,
};
