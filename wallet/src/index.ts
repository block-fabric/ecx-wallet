export { ErrorCode, ProviderRpcError } from "./errors";
export { GRANTABLE_METHODS, covers, widen, type Grant, type GrantStore, type GrantableMethod, type Scope } from "./grants";
export { createProviderHandler, type ConnectPrompt, type ProviderDeps } from "./provider";
export { CoreModule, CoreModuleError, type CoreArg } from "./wasm";
export { loadVaultModule, type KdfParams, type VaultModule } from "./vault-module";
export {
  CHAIN_MODULE_FILES,
  SUPPORTED_SLOTS,
  createAccounts,
  createChainModules,
  type Accounts,
  type AccountsDeps,
  type SlotAddress,
} from "./accounts";
export {
  loadChainModule,
  type Account,
  type Binding,
  type ChainEntry,
  type ChainModule,
  type Declaration,
  type DerivedAddress,
  type NetworkEntry,
} from "./chain-module";
export {
  createVault,
  DEFAULT_AUTO_LOCK_MINUTES,
  INCORRECT_PASSWORD,
  MIN_PASSWORD_LENGTH,
  VaultError,
  type KeyValueStore,
  type Vault,
  type VaultDeps,
  type VaultStatus,
} from "./vault";
