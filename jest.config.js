/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: { '^.+\\.ts$': 'ts-jest' },
  clearMocks: true,
  restoreMocks: true,
};
