export { ErrorCode, ProviderRpcError } from "./errors";
export { GRANTABLE_METHODS, covers, widen, type Grant, type GrantStore, type GrantableMethod, type Scope } from "./grants";
export { createProviderHandler, type ConnectPrompt, type ProviderDeps } from "./provider";
export { CoreModule, CoreModuleError, type CoreArg } from "./wasm";
export { loadVaultModule, type KdfParams, type VaultModule } from "./vault-module";
