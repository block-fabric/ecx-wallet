//! eCash's Chain Entry: the root of the tree (no Slot, no parent; docs/adr/0003). It ships with
//! the module (embedded from `chain-entry.json`) and the wallet reads it through `chain_entry()`.
//!
//! betanet's identity block is the fork block, 967,680: its genesis is Bitcoin's. `EcashHeight` is
//! 967680 on the `betanet` branch of github.com/ecash-com/bitcoin (`src/kernel/chainparams.cpp`),
//! which carries no hash for it. The hash was read on 2026-10-20 from esplora.beta.ecash.ninja and
//! explorer.beta.ecash.ninja, which agree; Bitcoin's block 967,680 differs and its 967,679 is the
//! same. So a Bitcoin server fails the check, as does an ECX mainnet one (mainnet forks later, at
//! 973,728, so its 967,680 is Bitcoin's).
//!
//! `build.rs` picks the file: `chain-entry.json`, or `$ECX_L1_CHAIN_ENTRY` for the e2e build,
//! whose Chain Entry differs only in its Sidechain Servers.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub use ecx_chain_entry::{IdentityBlock, ServerApi, SidechainServerEntry};

/// The raw JSON, as shipped.
pub const CHAIN_ENTRY_JSON: &str = include_str!(env!("ECX_L1_CHAIN_ENTRY_PATH"));

pub type ChainEntry = ecx_chain_entry::ChainEntry<L1Params>;
pub type NetworkEntry = ecx_chain_entry::NetworkEntry<L1Params>;

/// L1's own per-network values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct L1Params {
    pub address_params: AddressParamsEntry,
}

/// Bitcoin Core's `base58Prefixes` and `bech32_hrp`. betanet's are `CMainParams`' on the `betanet`
/// branch: P2PKH 0, P2SH 5, "bc" (checked 2026-10-20).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddressParamsEntry {
    pub p2pkh_prefix: u8,
    pub p2sh_prefix: u8,
    pub bech_hrp: String,
}

/// The parsed Chain Entry. The JSON is compiled in, so a parse failure is a build bug.
pub fn chain_entry() -> &'static ChainEntry {
    static ENTRY: OnceLock<ChainEntry> = OnceLock::new();
    ENTRY.get_or_init(|| {
        let entry: ChainEntry = serde_json::from_str(CHAIN_ENTRY_JSON).expect("chain-entry.json is valid");
        entry.check().expect("chain-entry.json is valid");
        entry
    })
}
