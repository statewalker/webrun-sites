/** acorn's ESTree node types, for code that walks a `parseSource` tree. */
export type * as AcornAst from "acorn";
export { newDefaultEndpointResolver } from "./deps/endpoint-resolver.js";
export { globalHostRegistry, newHostRegistry } from "./deps/host-registry.js";
export { proxyBody, proxyId } from "./deps/proxy.js";
export type {
  InputType,
  PreprocessContext,
  RegisteredTransform,
  TransformRegistry,
  UrlPolicy,
} from "./preprocess/context.js";
export {
  coarseBucket,
  defaultGlobals,
  detectInputType,
  makeKeepExtPolicy,
  normalizeDepsFolder,
  urlPath,
} from "./preprocess/context.js";
export { cssModuleWrapper, preprocessModule, serveJsonModule } from "./preprocess/module.js";
export {
  newDefaultTransformRegistry,
  newTransformRegistry,
} from "./preprocess/registry.js";
export { makeDefaultEndpointResolver, rawBytes, resolveSpec } from "./preprocess/resolve.js";
export { walkFrom } from "./preprocess/walk.js";
export { resolveNodeBuiltin } from "./resolution/node-builtins.js";
export { resolveEntry } from "./resolution/resolve-entry.js";
export { corsHeaders, withHeaders } from "./server/cors.js";
export { newModuleServer } from "./server/new-module-server.js";
export { parseSpecifier, relativeUrl } from "./server/specifiers.js";
export type { NpmRegistrySourceOptions } from "./sources/npm-registry-source.js";
export { npmRegistrySource } from "./sources/npm-registry-source.js";
export { untarTgz } from "./sources/untar.js";
export { analyze } from "./transform/analyze.js";
export { newDefaultCssTransform, newLightningCssTransform } from "./transform/css/index.js";
export {
  detectFormat,
  newCjsTransform,
  newDefaultTransform,
  newEsmTransform,
} from "./transform/index.js";
export type { ParsedSource } from "./transform/parse-source.js";
export { parseSource } from "./transform/parse-source.js";
export { toJs } from "./transform/to-js.js";
export type {
  CssFile,
  CssTransform,
  CssTransformResult,
  EndpointBinding,
  EndpointCtx,
  EndpointResolver,
  HostRegistry,
  LoadedPackage,
  Lockfile,
  ModuleDescriptor,
  ModuleImport,
  ModuleRef,
  ModuleServer,
  ModuleServerOptions,
  ModuleTarget,
  PackageManifest,
  ResolvedModule,
  Source,
  SourceFile,
  SourceFormat,
  Transform,
  TransformResult,
} from "./types.js";
export { ModuleResolveError, ModuleTransformError } from "./types.js";
