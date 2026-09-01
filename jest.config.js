/** @type {import('jest').Config} */
export default {
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  testMatch: [
    '**/test/**/*.test.ts',
    '**/test/**/*.spec.ts'
  ],
  // swc, not ts-jest: ts-jest peers on `typescript >=4.3 <7` and this repo builds
  // against 7, so every suite died in ConfigSet before a test ran — 20 files, 0
  // tests, reported as twenty separate failures. swc strips types instead of
  // asking the compiler to, so it has no TypeScript version to disagree with.
  //
  // Nothing is lost by not typechecking here: `tsc --noEmit` is a gate of its own
  // and runs on every push, so a type error fails the build rather than one suite.
  transform: {
    '^.+\\.ts$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testTimeout: 10000,
  verbose: true
};