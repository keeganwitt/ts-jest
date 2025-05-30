import { basename, normalize } from 'path'

import { LogContexts, Logger, LogLevels } from 'bs-logger'
import memoize from 'lodash.memoize'
import ts, {
  Bundle,
  CompilerOptions,
  CustomTransformerFactory,
  CustomTransformers,
  Diagnostic,
  EmitOutput,
  LanguageService,
  LanguageServiceHost,
  ModuleResolutionCache,
  ModuleResolutionHost,
  ParsedCommandLine,
  Program,
  ResolvedModuleFull,
  ResolvedModuleWithFailedLookupLocations,
  SourceFile,
  TransformerFactory,
  TranspileOutput,
} from 'typescript'

import { JS_JSX_REGEX, LINE_FEED, TS_TSX_REGEX } from '../../constants'
import { isModernNodeModuleKind, tsTranspileModule } from '../../transpilers/typescript/transpile-module'
import type {
  StringMap,
  TsCompilerInstance,
  TsJestAstTransformer,
  TsJestCompileOptions,
  TTypeScript,
  CompiledOutput,
} from '../../types'
import { rootLogger } from '../../utils'
import { Errors, Helps, interpolate } from '../../utils/messages'
import type { ConfigSet } from '../config/config-set'

import { updateOutput } from './compiler-utils'

const assertCompilerOptionsWithJestTransformMode = (
  compilerOptions: ts.CompilerOptions,
  isEsmMode: boolean,
  logger: Logger,
): void => {
  if (isEsmMode && compilerOptions.module === ts.ModuleKind.CommonJS) {
    logger.error(Errors.InvalidModuleKindForEsm)
  }
}

export class TsCompiler implements TsCompilerInstance {
  protected readonly _logger: Logger
  protected readonly _ts: TTypeScript
  protected readonly _initialCompilerOptions: CompilerOptions
  protected _compilerOptions: CompilerOptions
  /**
   * @private
   */
  private _runtimeCacheFS: StringMap
  /**
   * @private
   */
  private _fileContentCache: StringMap | undefined
  /**
   * @internal
   */
  private readonly _parsedTsConfig: ParsedCommandLine
  /**
   * @internal
   */
  private readonly _fileVersionCache: Map<string, number> | undefined
  /**
   * @internal
   */
  private readonly _cachedReadFile: LanguageServiceHost['readFile'] | undefined
  /**
   * @internal
   */
  private _projectVersion = 1
  /**
   * @internal
   */
  private _languageService: LanguageService | undefined
  /**
   * @internal
   */
  private readonly _moduleResolutionHost: ModuleResolutionHost | undefined
  /**
   * @internal
   */
  private readonly _moduleResolutionCache: ModuleResolutionCache | undefined

  program: Program | undefined

  constructor(readonly configSet: ConfigSet, readonly runtimeCacheFS: StringMap) {
    this._ts = configSet.compilerModule
    this._logger = rootLogger.child({ namespace: 'ts-compiler' })
    this._parsedTsConfig = this.configSet.parsedTsConfig as ParsedCommandLine
    this._initialCompilerOptions = { ...this._parsedTsConfig.options }
    this._compilerOptions = { ...this._initialCompilerOptions }
    this._runtimeCacheFS = runtimeCacheFS
    if (!this.configSet.isolatedModules) {
      this._fileContentCache = new Map<string, string>()
      this._fileVersionCache = new Map<string, number>()
      this._cachedReadFile = this._logger.wrap(
        {
          namespace: 'ts:serviceHost',
          call: null,
          [LogContexts.logLevel]: LogLevels.trace,
        },
        'readFile',
        memoize(this._ts.sys.readFile),
      )
      /* istanbul ignore next */
      this._moduleResolutionHost = {
        fileExists: memoize(this._ts.sys.fileExists),
        readFile: this._cachedReadFile,
        directoryExists: memoize(this._ts.sys.directoryExists),
        getCurrentDirectory: () => this.configSet.cwd,
        realpath: this._ts.sys.realpath && memoize(this._ts.sys.realpath),
        getDirectories: memoize(this._ts.sys.getDirectories),
        useCaseSensitiveFileNames: () => this._ts.sys.useCaseSensitiveFileNames,
      }
      this._moduleResolutionCache = this._ts.createModuleResolutionCache(
        this.configSet.cwd,
        this._ts.sys.useCaseSensitiveFileNames ? (x) => x : (x) => x.toLowerCase(),
        this._compilerOptions,
      )
      this._createLanguageService()
    }
  }

  getResolvedModules(fileContent: string, fileName: string, runtimeCacheFS: StringMap): string[] {
    // In watch mode, it is possible that the initial cacheFS becomes empty
    if (!this.runtimeCacheFS.size) {
      this._runtimeCacheFS = runtimeCacheFS
    }

    this._logger.debug({ fileName }, 'getResolvedModules(): resolve direct imported module paths')

    const importedModulePaths: string[] = Array.from(new Set(this._getImportedModulePaths(fileContent, fileName)))

    this._logger.debug(
      { fileName },
      'getResolvedModules(): resolve nested imported module paths from directed imported module paths',
    )

    importedModulePaths.forEach((importedModulePath) => {
      const resolvedFileContent = this._getFileContentFromCache(importedModulePath)
      importedModulePaths.push(
        ...this._getImportedModulePaths(resolvedFileContent, importedModulePath).filter(
          (modulePath) => !importedModulePaths.includes(modulePath),
        ),
      )
    })

    return importedModulePaths
  }

  private fixupCompilerOptionsForModuleKind(compilerOptions: CompilerOptions, isEsm: boolean): CompilerOptions {
    const moduleResolution = this._ts.ModuleResolutionKind.Node10 ?? this._ts.ModuleResolutionKind.NodeJs
    if (!isEsm) {
      return {
        ...compilerOptions,
        module: this._ts.ModuleKind.CommonJS,
        moduleResolution,
        /**
         * This option is only supported in `Node16`/`NodeNext` and `Bundler` module, see https://www.typescriptlang.org/tsconfig/#customConditions
         */
        customConditions: undefined,
      }
    }

    let moduleKind = compilerOptions.module ?? this._ts.ModuleKind.ESNext
    let esModuleInterop = compilerOptions.esModuleInterop
    if (isModernNodeModuleKind(moduleKind)) {
      esModuleInterop = true
      moduleKind = this._ts.ModuleKind.ESNext
    }

    return {
      ...compilerOptions,
      module: moduleKind,
      esModuleInterop,
      moduleResolution,
      /**
       * This option is only supported in `Node16`/`NodeNext` and `Bundler` module, see https://www.typescriptlang.org/tsconfig/#customConditions
       */
      customConditions: undefined,
    }
  }

  getCompiledOutput(fileContent: string, fileName: string, options: TsJestCompileOptions): CompiledOutput {
    const isEsmMode = this.configSet.useESM && options.supportsStaticESM
    this._compilerOptions = this.fixupCompilerOptionsForModuleKind(this._initialCompilerOptions, isEsmMode)
    if (!this._initialCompilerOptions.isolatedModules && isModernNodeModuleKind(this._initialCompilerOptions.module)) {
      this._logger.warn(Helps.UsingModernNodeResolution)
    }

    const moduleKind = this._initialCompilerOptions.module
    const currentModuleKind = this._compilerOptions.module
    if (this._languageService) {
      if (JS_JSX_REGEX.test(fileName) && !this._compilerOptions.allowJs) {
        this._logger.warn({ fileName: fileName }, interpolate(Errors.GotJsFileButAllowJsFalse, { path: fileName }))

        return {
          code: fileContent,
        }
      }

      this._logger.debug({ fileName }, 'getCompiledOutput(): compiling using language service')

      // Must set memory cache before attempting to compile
      this._updateMemoryCache(fileContent, fileName, currentModuleKind === moduleKind)
      const output: EmitOutput = this._languageService.getEmitOutput(fileName)
      const diagnostics = this.getDiagnostics(fileName)
      if (!isEsmMode && diagnostics.length) {
        this.configSet.raiseDiagnostics(diagnostics, fileName, this._logger)
        if (options.watchMode) {
          this._logger.debug({ fileName }, '_doTypeChecking(): starting watch mode computing diagnostics')

          for (const entry of options.depGraphs.entries()) {
            const normalizedModuleNames = entry[1].resolvedModuleNames.map((moduleName) => normalize(moduleName))
            const fileToReTypeCheck = entry[0]
            if (normalizedModuleNames.includes(fileName) && this.configSet.shouldReportDiagnostics(fileToReTypeCheck)) {
              this._logger.debug(
                { fileToReTypeCheck },
                '_doTypeChecking(): computing diagnostics using language service',
              )

              this._updateMemoryCache(this._getFileContentFromCache(fileToReTypeCheck), fileToReTypeCheck)
              const importedModulesDiagnostics = [
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                ...this._languageService!.getSemanticDiagnostics(fileToReTypeCheck),
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                ...this._languageService!.getSyntacticDiagnostics(fileToReTypeCheck),
              ]
              // will raise or just warn diagnostics depending on config
              this.configSet.raiseDiagnostics(importedModulesDiagnostics, fileName, this._logger)
            }
          }
        }
      }
      if (output.emitSkipped) {
        if (TS_TSX_REGEX.test(fileName)) {
          throw new Error(interpolate(Errors.CannotProcessFile, { file: fileName }))
        } else {
          this._logger.warn(interpolate(Errors.CannotProcessFileReturnOriginal, { file: fileName }))

          return {
            code: fileContent,
          }
        }
      }
      // Throw an error when requiring `.d.ts` files.
      if (!output.outputFiles.length) {
        throw new TypeError(
          interpolate(Errors.UnableToRequireDefinitionFile, {
            file: basename(fileName),
          }),
        )
      }
      const { outputFiles } = output

      return this._compilerOptions.sourceMap
        ? {
            code: updateOutput(outputFiles[1].text, fileName, outputFiles[0].text),
            diagnostics,
          }
        : {
            code: updateOutput(outputFiles[0].text, fileName),
            diagnostics,
          }
    } else {
      this._logger.debug({ fileName }, 'getCompiledOutput(): compiling as isolated module')

      assertCompilerOptionsWithJestTransformMode(this._initialCompilerOptions, isEsmMode, this._logger)

      const result = this._transpileOutput(fileContent, fileName)
      if (result.diagnostics && this.configSet.shouldReportDiagnostics(fileName)) {
        this.configSet.raiseDiagnostics(result.diagnostics, fileName, this._logger)
      }

      return {
        code: updateOutput(result.outputText, fileName, result.sourceMapText),
      }
    }
  }

  protected _transpileOutput(fileContent: string, fileName: string): TranspileOutput {
    /**
     * @deprecated
     *
     * This code path should be removed in the next major version to benefit from checking on compiler options
     */
    if (!isModernNodeModuleKind(this._initialCompilerOptions.module)) {
      return this._ts.transpileModule(fileContent, {
        fileName,
        transformers: this._makeTransformers(this.configSet.resolvedTransformers),
        compilerOptions: this._compilerOptions,
        reportDiagnostics: this.configSet.shouldReportDiagnostics(fileName),
      })
    }

    return tsTranspileModule(fileContent, {
      fileName,
      transformers: (program) => {
        this.program = program

        return this._makeTransformers(this.configSet.resolvedTransformers)
      },
      compilerOptions: this._initialCompilerOptions,
      reportDiagnostics: fileName ? this.configSet.shouldReportDiagnostics(fileName) : false,
    })
  }

  protected _makeTransformers(customTransformers: TsJestAstTransformer): CustomTransformers {
    return {
      before: customTransformers.before.map((beforeTransformer) =>
        beforeTransformer.factory(this, beforeTransformer.options),
      ) as Array<TransformerFactory<SourceFile> | CustomTransformerFactory>,
      after: customTransformers.after.map((afterTransformer) =>
        afterTransformer.factory(this, afterTransformer.options),
      ) as Array<TransformerFactory<SourceFile> | CustomTransformerFactory>,
      afterDeclarations: customTransformers.afterDeclarations.map((afterDeclarations) =>
        afterDeclarations.factory(this, afterDeclarations.options),
      ) as Array<TransformerFactory<SourceFile | Bundle>>,
    }
  }

  /**
   * @internal
   */
  private _createLanguageService(): void {
    // Initialize memory cache for typescript compiler
    this._parsedTsConfig.fileNames
      .filter((fileName) => TS_TSX_REGEX.test(fileName) && !this.configSet.isTestFile(fileName))
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .forEach((fileName) => this._fileVersionCache!.set(fileName, 0))
    /* istanbul ignore next */
    const serviceHost: LanguageServiceHost = {
      useCaseSensitiveFileNames: () => this._ts.sys.useCaseSensitiveFileNames,
      getProjectVersion: () => String(this._projectVersion),
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      getScriptFileNames: () => [...this._fileVersionCache!.keys()],
      getScriptVersion: (fileName: string) => {
        const normalizedFileName = normalize(fileName)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const version = this._fileVersionCache!.get(normalizedFileName)

        // We need to return `undefined` and not a string here because TypeScript will use
        // `getScriptVersion` and compare against their own version - which can be `undefined`.
        // If we don't return `undefined` it results in `undefined === "undefined"` and run
        // `createProgram` again (which is very slow). Using a `string` assertion here to avoid
        // TypeScript errors from the function signature (expects `(x: string) => string`).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return version === undefined ? (undefined as any as string) : String(version)
      },
      getScriptSnapshot: (fileName: string) => {
        const normalizedFileName = normalize(fileName)
        const hit = this._isFileInCache(normalizedFileName)

        this._logger.trace({ normalizedFileName, cacheHit: hit }, 'getScriptSnapshot():', 'cache', hit ? 'hit' : 'miss')

        // Read file content from either memory cache or Jest runtime cache or fallback to file system read
        if (!hit) {
          const fileContent =
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this._fileContentCache!.get(normalizedFileName) ??
            this._runtimeCacheFS.get(normalizedFileName) ??
            this._cachedReadFile?.(normalizedFileName) ??
            undefined
          if (fileContent !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this._fileContentCache!.set(normalizedFileName, fileContent)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this._fileVersionCache!.set(normalizedFileName, 1)
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const contents = this._fileContentCache!.get(normalizedFileName)

        if (contents === undefined) return

        return this._ts.ScriptSnapshot.fromString(contents)
      },
      fileExists: memoize(this._ts.sys.fileExists),
      readFile: this._cachedReadFile ?? this._ts.sys.readFile,
      readDirectory: memoize(this._ts.sys.readDirectory),
      getDirectories: memoize(this._ts.sys.getDirectories),
      directoryExists: memoize(this._ts.sys.directoryExists),
      realpath: this._ts.sys.realpath && memoize(this._ts.sys.realpath),
      getNewLine: () => LINE_FEED,
      getCurrentDirectory: () => this.configSet.cwd,
      getCompilationSettings: () => this._compilerOptions,
      getDefaultLibFileName: () => this._ts.getDefaultLibFilePath(this._compilerOptions),
      getCustomTransformers: () => this._makeTransformers(this.configSet.resolvedTransformers),
      resolveModuleNames: (moduleNames: string[], containingFile: string): Array<ResolvedModuleFull | undefined> =>
        moduleNames.map((moduleName) => this._resolveModuleName(moduleName, containingFile).resolvedModule),
    }

    this._logger.debug('created language service')

    this._languageService = this._ts.createLanguageService(
      serviceHost,
      this._ts.createDocumentRegistry(this._ts.sys.useCaseSensitiveFileNames, this.configSet.cwd),
    )
    this.program = this._languageService.getProgram()
  }

  /**
   * @internal
   */
  private _getFileContentFromCache(filePath: string): string {
    const normalizedFilePath = normalize(filePath)
    let resolvedFileContent = this._runtimeCacheFS.get(normalizedFilePath)
    if (!resolvedFileContent) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      resolvedFileContent = this._moduleResolutionHost!.readFile(normalizedFilePath)!
      this._runtimeCacheFS.set(normalizedFilePath, resolvedFileContent)
    }

    return resolvedFileContent
  }

  /**
   * @internal
   */
  private _getImportedModulePaths(resolvedFileContent: string, containingFile: string): string[] {
    return this._ts
      .preProcessFile(resolvedFileContent, true, true)
      .importedFiles.map((importedFile) => {
        const { resolvedModule } = this._resolveModuleName(importedFile.fileName, containingFile)
        /* istanbul ignore next already covered  */
        const resolvedFileName = resolvedModule?.resolvedFileName

        /* istanbul ignore next already covered  */
        return resolvedFileName && !resolvedModule?.isExternalLibraryImport ? resolvedFileName : ''
      })
      .filter((resolveFileName) => !!resolveFileName)
  }

  /**
   * @internal
   */
  private _resolveModuleName(
    moduleNameToResolve: string,
    containingFile: string,
  ): ResolvedModuleWithFailedLookupLocations {
    return this._ts.resolveModuleName(
      moduleNameToResolve,
      containingFile,
      this._compilerOptions,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._moduleResolutionHost!,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._moduleResolutionCache!,
    )
  }

  /**
   * @internal
   */
  private _isFileInCache(fileName: string): boolean {
    return (
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._fileContentCache!.has(fileName) &&
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._fileVersionCache!.has(fileName) &&
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._fileVersionCache!.get(fileName) !== 0
    )
  }

  /**
   * @internal
   */
  private _updateMemoryCache(contents: string, fileName: string, isModuleKindTheSame = true): void {
    this._logger.debug({ fileName }, 'updateMemoryCache: update memory cache for language service')

    let shouldIncrementProjectVersion = false
    const hit = this._isFileInCache(fileName)
    if (!hit) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._fileVersionCache!.set(fileName, 1)
      shouldIncrementProjectVersion = true
    } else {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const prevVersion = this._fileVersionCache!.get(fileName)!
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const previousContents = this._fileContentCache!.get(fileName)
      // Avoid incrementing cache when nothing has changed.
      if (previousContents !== contents) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._fileVersionCache!.set(fileName, prevVersion + 1)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        this._fileContentCache!.set(fileName, contents)
        shouldIncrementProjectVersion = true
      }
      /**
       * When a file is from node_modules or referenced to a referenced project and jest wants to transform it, we need
       * to make sure that the Program is updated with this information
       */
      if (!this._parsedTsConfig.fileNames.includes(fileName) || !isModuleKindTheSame) {
        shouldIncrementProjectVersion = true
      }
    }

    if (shouldIncrementProjectVersion) this._projectVersion++
  }

  /**
   * @internal
   */
  private getDiagnostics(fileName: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    if (this.configSet.shouldReportDiagnostics(fileName)) {
      this._logger.debug({ fileName }, '_doTypeChecking(): computing diagnostics using language service')

      // Get the relevant diagnostics - this is 3x faster than `getPreEmitDiagnostics`.
      diagnostics.push(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ...this._languageService!.getSemanticDiagnostics(fileName),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ...this._languageService!.getSyntacticDiagnostics(fileName),
      )
    }

    return diagnostics
  }
}
