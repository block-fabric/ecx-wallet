//! Slot 24's Chain Entry: the one place betanet's per-network values live. It ships with the
//! module (embedded from `chain-entry.json`) and the wallet reads it through `chain_entry()`. The
//! envelope is `ecx-chain-entry`'s; `params` are this module's own.
//!
//! `build.rs` picks the file: `chain-entry.json`, or `$ECX_ELEMENTS_CHAIN_ENTRY` for the e2e
//! build, whose Chain Entry differs only in its Sidechain Servers.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub use ecx_chain_entry::{IdentityBlock, ServerApi, SidechainServerEntry};

/// The raw JSON, as shipped.
pub const CHAIN_ENTRY_JSON: &str = include_str!(env!("ECX_ELEMENTS_CHAIN_ENTRY_PATH"));

pub type ChainEntry = ecx_chain_entry::ChainEntry<ElementsParams>;
pub type NetworkEntry = ecx_chain_entry::NetworkEntry<ElementsParams>;

/// Elements' own per-network values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementsParams {
    /// Display hex, as Elements prints it. The identity block is this, at height 0.
    pub genesis_hash: String,
    /// The L1 (eCash) genesis, display hex: Elements' peg parameter, which a native-withdrawal burn
    /// commits to. Not a reference to the parent chain (that's the envelope's `parent`).
    pub parent_genesis_hash: String,
    /// The pegged asset, display hex.
    pub policy_asset: String,
    pub address_params: AddressParamsEntry,
    /// How the parent (L1) chain encodes addresses: a Withdrawal's L1 destination is shown in it.
    /// Must equal the parent's `addressParams` (checked by the wallet's tests).
    pub parent_address_params: ParentAddressParamsEntry,
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
/// betanet's parent is ECX betanet, whose node runs `CMainParams` from github.com/ecash-com/bitcoin
/// `src/kernel/chainparams.cpp` (commit 6e582335 on `master`; the `betanet` branch agrees,
/// checked 2026-10-20): `base58Prefixes[PUBKEY_ADDRESS]` is 0, `base58Prefixes[SCRIPT_ADDRESS]` 5
/// and `bech32_hrp` "bc".
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
    ENTRY.get_or_init(|| {
        let entry: ChainEntry = serde_json::from_str(CHAIN_ENTRY_JSON).expect("chain-entry.json is valid");
        entry.check().expect("chain-entry.json is valid");
        entry
    })
}
