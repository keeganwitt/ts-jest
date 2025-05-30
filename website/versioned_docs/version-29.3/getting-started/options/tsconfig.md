---
title: TypeScript Config option
---

The `tsconfig` option allows you to define which `tsconfig` JSON file to use. An inline [compiler options][] object can also be specified instead of a file path.

By default `ts-jest` will try to find a `tsconfig.json` in your project. If it cannot find one, it will use the default TypeScript [compiler options][]; except, `ES2015` is used as `target` instead of `ES5`.

If you need to use defaults and force `ts-jest` to use the defaults even if there is a `tsconfig.json` in your project, you can set this option to `false`.

### Examples

#### Path to a `tsconfig` file

The path should be relative to the current working directory where you start Jest from. You can also use `<rootDir>` in the path to start from the project root dir.

```ts title="jest.config.ts"
import type { Config } from 'jest'

const jestConfig: JestConfigWithTsJest = {
  // [...]
  transform: {
    // '^.+\\.[tj]sx?$' to process ts,js,tsx,jsx with `ts-jest`
    // '^.+\\.m?[tj]sx?$' to process ts,js,tsx,jsx,mts,mjs,mtsx,mjsx with `ts-jest`
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
}

export default jestConfig
```

#### Inline compiler options

Refer to the TypeScript [compiler options][] for reference.
It's basically the same object you'd put in your `tsconfig.json`'s `compilerOptions`.

```ts title="jest.config.ts"
import type { Config } from 'jest'

const jestConfig: Config = {
  // [...]
  transform: {
    // '^.+\\.[tj]sx?$' to process ts,js,tsx,jsx with `ts-jest`
    // '^.+\\.m?[tj]sx?$' to process ts,js,tsx,jsx,mts,mjs,mtsx,mjsx with `ts-jest`
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          importHelpers: true,
        },
      },
    ],
  },
}

export default jestConfig
```

#### Disable auto-lookup

By default `ts-jest` will try to find a `tsconfig.json` in your project. But you may not want to use it at all and keep TypeScript default options. You can achieve this by setting `tsconfig` to `false`.

```ts title="jest.config.ts"
import type { Config } from 'jest'

const jestConfig: Config = {
  // [...]
  transform: {
    // '^.+\\.[tj]sx?$' to process ts,js,tsx,jsx with `ts-jest`
    // '^.+\\.m?[tj]sx?$' to process ts,js,tsx,jsx,mts,mjs,mtsx,mjsx with `ts-jest`
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: false,
      },
    ],
  },
}

export default jestConfig
```

[compiler options]: https://www.typescriptlang.org/tsconfig
