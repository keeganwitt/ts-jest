import { type JestConfigWithTsJest, TS_JS_TRANSFORM_PATTERN } from 'ts-jest'

export default {
  displayName: 'transform-js-transpiler-esm',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    [TS_JS_TRANSFORM_PATTERN]: [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig-esm-transpiler.spec.json',
        useESM: true,
      },
    ],
  },
} satisfies JestConfigWithTsJest
