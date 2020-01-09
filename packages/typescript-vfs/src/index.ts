const AUDIT = false

type System = import('typescript').System
type CompilerOptions = import('typescript').CompilerOptions
type LanguageServiceHost = import('typescript').LanguageServiceHost
type CompilerHost = import('typescript').CompilerHost
type SourceFile = import('typescript').SourceFile
type TS = typeof import('typescript')

function notImplemented(methodName: string): any {
  throw new Error(`Method '${methodName}' is not implemented.`)
}

function audit<ArgsT extends any[], ReturnT>(
  name: string,
  fn: (...args: ArgsT) => ReturnT
): (...args: ArgsT) => ReturnT {
  return (...args) => {
    if (AUDIT) {
      // tslint:disable-next-line:no-console
      console.log(name, ...args)
    }
    return fn(...args)
  }
}

const defaultCompilerOptions = (ts: typeof import('typescript')) => {
  return {
    ...ts.getDefaultCompilerOptions(),
    jsx: ts.JsxEmit.React,
    strict: true,
    target: ts.ScriptTarget.ES2015,
    esModuleInterop: true,
    module: ts.ModuleKind.ESNext,
    suppressOutputPathCheck: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  }
}

export function createSystem(files: Map<string, string>): System {
  files = new Map(files)
  return {
    args: [],
    createDirectory: () => notImplemented('createDirectory'),
    // TODO: could make a real file tree
    directoryExists: audit('directoryExists', directory => {
      return Array.from(files.keys()).some(path => path.startsWith(directory))
    }),
    exit: () => notImplemented('exit'),
    fileExists: audit('fileExists', fileName => files.has(fileName)),
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    getExecutingFilePath: () => notImplemented('getExecutingFilePath'),
    readDirectory: audit('readDirectory', directory => (directory === '/' ? Array.from(files.keys()) : [])),
    readFile: audit('readFile', fileName => files.get(fileName)),
    resolvePath: path => path,
    newLine: '\n',
    useCaseSensitiveFileNames: true,
    write: () => notImplemented('write'),
    writeFile: (fileName, contents) => {
      files.set(fileName, contents)
    },
  }
}

export function createVirtualCompilerHost(sys: System, compilerOptions: CompilerOptions, ts: TS) {
  const sourceFiles = new Map<string, SourceFile>()
  const save = (sourceFile: SourceFile) => {
    sourceFiles.set(sourceFile.fileName, sourceFile)
    return sourceFile
  }

  type Return = {
    compilerHost: CompilerHost
    updateFile: (sourceFile: SourceFile) => boolean
  }

  const vHost: Return = {
    compilerHost: {
      ...sys,
      getCanonicalFileName: fileName => fileName,
      getDefaultLibFileName: () => '/lib.es2015.d.ts',
      getDirectories: () => [],
      getNewLine: () => sys.newLine,
      getSourceFile: fileName => {
        return (
          sourceFiles.get(fileName) ||
          save(
            ts.createSourceFile(
              fileName,
              sys.readFile(fileName)!,
              compilerOptions.target || defaultCompilerOptions(ts).target,
              false
            )
          )
        )
      },
      useCaseSensitiveFileNames: () => sys.useCaseSensitiveFileNames,
    },
    updateFile: sourceFile => {
      const alreadyExists = sourceFiles.has(sourceFile.fileName)
      sys.writeFile(sourceFile.fileName, sourceFile.text)
      sourceFiles.set(sourceFile.fileName, sourceFile)
      return alreadyExists
    },
  }
  return vHost
}

export function createVirtualLanguageServiceHost(
  sys: System,
  rootFiles: string[],
  compilerOptions: CompilerOptions,
  ts: TS
) {
  const fileNames = [...rootFiles]
  const { compilerHost, updateFile } = createVirtualCompilerHost(sys, compilerOptions, ts)
  const fileVersions = new Map<string, string>()
  let projectVersion = 0
  const languageServiceHost: LanguageServiceHost = {
    ...compilerHost,
    getProjectVersion: () => projectVersion.toString(),
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => fileNames,
    getScriptSnapshot: fileName => {
      const contents = sys.readFile(fileName)
      if (contents) {
        return ts.ScriptSnapshot.fromString(contents)
      }
      return
    },
    getScriptVersion: fileName => {
      return fileVersions.get(fileName) || '0'
    },
    writeFile: sys.writeFile,
  }

  type Return = {
    languageServiceHost: LanguageServiceHost
    updateFile: (sourceFile: import('typescript').SourceFile) => void
  }

  const lsHost: Return = {
    languageServiceHost,
    updateFile: sourceFile => {
      projectVersion++
      fileVersions.set(sourceFile.fileName, projectVersion.toString())
      if (!fileNames.includes(sourceFile.fileName)) {
        fileNames.push(sourceFile.fileName)
      }
      updateFile(sourceFile)
    },
  }
  return lsHost
}

export interface VirtualTypeScriptEnvironment {
  sys: System
  languageService: import('typescript').LanguageService
  createFile: (fileName: string, content: string) => void
  updateFile: (fileName: string, content: string, replaceTextSpan: import('typescript').TextSpan) => void
}

/**
 * Makes a virtual copy of the TypeScript environment
 *
 * @param sys an object which conforms to the TS Sys (a shim over read/write access to the fs)
 * @param rootFiles a list of files which are considered inside the project
 * @param ts a copy pf the TypeScript module
 * @param compilerOptions the options for this compiler run
 */

export function createVirtualTypeScriptEnvironment(
  sys: System,
  rootFiles: string[],
  ts: TS,
  compilerOptions: CompilerOptions = {}
): VirtualTypeScriptEnvironment {
  const mergedCompilerOptions = { ...defaultCompilerOptions(ts), ...compilerOptions }
  // prettier-ignore
  const { languageServiceHost, updateFile } = createVirtualLanguageServiceHost(sys, rootFiles, mergedCompilerOptions, ts)

  const languageService = ts.createLanguageService(languageServiceHost)

  const diagnostics = languageService.getCompilerOptionsDiagnostics()
  if (diagnostics.length) {
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: sys.getCurrentDirectory,
        getNewLine: () => sys.newLine,
        getCanonicalFileName: fileName => fileName,
      })
    )
  }
  return {
    sys,
    languageService,
    createFile: (fileName, content) => {
      updateFile(ts.createSourceFile(fileName, content, mergedCompilerOptions.target, false))
    },
    updateFile: (fileName, content, prevTextSpan) => {
      const prevSourceFile = languageService.getProgram()!.getSourceFile(fileName)!
      const prevFullContents = prevSourceFile.text
      const newText =
        prevFullContents.slice(0, prevTextSpan.start) +
        content +
        prevFullContents.slice(prevTextSpan.start + prevTextSpan.length)
      const newSourceFile = ts.updateSourceFile(prevSourceFile, newText, {
        span: prevTextSpan,
        newLength: content.length,
      })

      updateFile(newSourceFile)
    },
  }
}

/**
 * Grab the list of lib files for a particular target, will return a bit more than necessary (by including
 * the dom) but that's OK
 *
 * @param target The compiler settings target baseline
 * @param ts A copy of the TypeScript module
 */
export const knownLibFilesForTarget = (target: import('typescript').ScriptTarget, ts: TS) => {
  const files = [
    'lib.d.ts',
    'lib.dom.d.ts',
    'lib.dom.iterable.d.ts',
    'lib.es5.d.ts',
    'lib.es6.d.ts',
    'lib.es2015.collection.d.ts',
    'lib.es2015.core.d.ts',
    'lib.es2015.d.ts',
    'lib.es2015.generator.d.ts',
    'lib.es2015.iterable.d.ts',
    'lib.es2015.promise.d.ts',
    'lib.es2015.proxy.d.ts',
    'lib.es2015.reflect.d.ts',
    'lib.es2015.symbol.d.ts',
    'lib.es2015.symbol.wellknown.d.ts',
    'lib.es2016.array.include.d.ts',
    'lib.es2016.d.ts',
    'lib.es2016.full.d.ts',
    'lib.es2017.d.ts',
    'lib.es2017.full.d.ts',
    'lib.es2017.intl.d.ts',
    'lib.es2017.object.d.ts',
    'lib.es2017.sharedmemory.d.ts',
    'lib.es2017.string.d.ts',
    'lib.es2017.typedarrays.d.ts',
    'lib.es2018.asyncgenerator.d.ts',
    'lib.es2018.asynciterable.d.ts',
    'lib.es2018.d.ts',
    'lib.es2018.full.d.ts',
    'lib.es2018.intl.d.ts',
    'lib.es2018.promise.d.ts',
    'lib.es2018.regexp.d.ts',
    'lib.es2019.array.d.ts',
    'lib.es2019.d.ts',
    'lib.es2019.full.d.ts',
    'lib.es2019.object.d.ts',
    'lib.es2019.string.d.ts',
    'lib.es2019.symbol.d.ts',
    'lib.es2020.d.ts',
    'lib.es2020.full.d.ts',
    'lib.es2020.string.d.ts',
    'lib.es2020.symbol.wellknown.d.ts',
    'lib.esnext.array.d.ts',
    'lib.esnext.asynciterable.d.ts',
    'lib.esnext.bigint.d.ts',
    'lib.esnext.d.ts',
    'lib.esnext.full.d.ts',
    'lib.esnext.intl.d.ts',
    'lib.esnext.symbol.d.ts',
  ]

  const targetToCut = ts.ScriptTarget[target]
  const matches = files.filter(f => f.startsWith(`lib.${targetToCut.toLowerCase()}`))
  const cutIndex = files.indexOf(matches.pop()!)
  return files.slice(0, cutIndex + 1)
}

/**
 * Sets up a Map with lib contents by grabbing the necessary files from
 * the local copy of typescript via the file system.
 *
 * @param target The compiler settings target baseline
 */
export const createDefaultMapFromNodeModules = (target: import('typescript').ScriptTarget) => {
  const ts = require('typescript')
  const path = require('path')
  const fs = require('fs')

  const getLib = (name: string) => {
    const lib = path.dirname(require.resolve('typescript'))
    return fs.readFileSync(path.join(lib, name), 'utf8')
  }

  const libs = knownLibFilesForTarget(target, ts)
  const fsMap = new Map<string, string>()
  libs.forEach(lib => {
    fsMap.set('/' + lib, getLib(lib))
  })
  return fsMap
}

/**
 * Create a virtual FS Map with the lib files from a particular TypeScript
 * version based on the target, Always includes dom ATM.
 *
 * @param target The compiler target, which dictates the libs to set up
 * @param version the versions of TypeScript which are supported
 * @param cache should the values be stored in local storage
 * @param ts a copy of the typescript import
 * @param lzstring an optional copy of the lz-string import
 * @param fetcher an optional replacement for the global fetch function (tests mainly)
 * @param storer an optional replacement for the localStorage global (tests mainly)
 */
export const createDefaultMapFromCDN = (
  target: import('typescript').ScriptTarget,
  version: string,
  cache: boolean,
  ts: TS,
  lzstring?: typeof import('lz-string'),
  fetcher?: typeof fetch,
  storer?: typeof localStorage
) => {
  const fetchlike = fetcher || fetch
  const storelike = storer || localStorage
  const fsMap = new Map<string, string>()
  const files = knownLibFilesForTarget(target, ts)
  const prefix = `https://tswebinfra.blob.core.windows.net/cdn/${version}/typescript/lib/`

  function zip(str: string) {
    return lzstring ? lzstring.compressToUTF16(str) : str
  }

  function unzip(str: string) {
    return lzstring ? lzstring.decompressFromUTF16(str) : str
  }

  // Map the known libs to a node fetch promise, then return the contents
  function uncached() {
    return Promise.all(files.map(lib => fetchlike(prefix + lib).then(resp => resp.text()))).then(contents => {
      contents.forEach((text, index) => {
        const name = '/' + files[index]
        fsMap.set(name, text)
      })
    })
  }

  // A localstorage and lzzip aware version of the lib files
  function cached() {
    const keys = Object.keys(localStorage)
    keys.forEach(key => {
      // Remove anything which isn't from this version
      if (key.startsWith('ts-lib-') && !key.startsWith('ts-lib-' + version)) {
        storelike.removeItem(key)
      }
    })

    return Promise.all(
      files.map(lib => {
        const cacheKey = `ts-lib-${version}-${lib}`
        const content = storelike.getItem(cacheKey)

        if (!content) {
          // Make the API call and store the text concent in the cache
          return fetchlike(prefix + lib)
            .then(resp => resp.text())
            .then(t => {
              storelike.setItem(name, zip(t))
              return t
            })
        } else {
          return Promise.resolve(unzip(content))
        }
      })
    ).then(contents => {
      contents.forEach((text, index) => {
        const name = '/' + files[index]
        fsMap.set(name, text)
      })
    })
  }

  const func = cache ? cached : uncached
  return func().then(() => fsMap)
}