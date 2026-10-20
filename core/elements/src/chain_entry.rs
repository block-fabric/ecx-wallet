//! Slot 24's Chain Entry: the one place betanet's per-network values live. It ships with the
//! module (embedded from `chain-entry.json`) and the wallet reads it through `chain_entry()`.
use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// The raw JSON, as shipped.
pub const CHAIN_ENTRY_JSON: &str = include_str!("../chain-entry.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainEntry {
    pub slot: u32,
    pub name: String,
    pub networks: BTreeMap<String, NetworkEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkEntry {
    /// CAIP-2 chain id, `ecash:<network>-s<slot>`.
    pub chain: String,
    /// Display hex, as Elements prints it.
    pub genesis_hash: String,
    /// The L1 (eCash) genesis, display hex.
    pub parent_genesis_hash: String,
    /// The pegged asset, display hex.
    pub policy_asset: String,
    pub address_params: AddressParamsEntry,
    /// How the parent (L1) chain encodes addresses: a Withdrawal's L1 destination is shown in it.
    pub parent_address_params: ParentAddressParamsEntry,
    /// Default Sidechain Server URL (placeholder until the stub server lands).
    pub sidechain_server: String,
    /// Official App origins (placeholder).
    pub official_apps: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddressParamsEntry {
    pub p2pkh_prefix: u8,
    pub p2sh_prefix: u8,
    pub blinded_prefix: u8,
    pub bech_hrp: String,
    pub blech_hrp: String,
}

/// An L1 chain's address encoding (Bitcoin Core's `base58Prefixes` and `bech32_hrp`).
///
/// betanet's parent is ECX mainnet: its `parentGenesisHash` is the genesis `CMainParams` asserts in
/// the ECX node, github.com/ecash-com/bitcoin `src/kernel/chainparams.cpp` (commit 6e582335), whose
/// `base58Prefixes[PUBKEY_ADDRESS]` is 0, `base58Prefixes[SCRIPT_ADDRESS]` 5 and `bech32_hrp` "bc".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentAddressParamsEntry {
    pub p2pkh_prefix: u8,
    pub p2sh_prefix: u8,
    pub bech_hrp: String,
}

/// The parsed Chain Entry. The JSON is compiled in, so a parse failure is a build bug.
pub fn chain_entry() -> &'static ChainEntry {
    static ENTRY: OnceLock<ChainEntry> = OnceLock::new();
    ENTRY.get_or_init(|| serde_json::from_str(CHAIN_ENTRY_JSON).expect("chain-entry.json is valid"))
}
