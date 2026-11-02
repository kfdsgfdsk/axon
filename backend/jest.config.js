/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // rpc-websockets pulls a nested ESM-only uuid; map to the CJS build so the
  // Solana/trading modules can be loaded in Jest.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/node_modules/uuid/dist/cjs/index.js',
  },
  clearMocks: true,
};
