//! Slot 24's Chain Entry: the one place betanet's per-network values live. It ships with the
//! module (embedded from `chain-entry.json`) and the wallet reads it through `chain_entry()`. The
//! envelope is `ecx-chain-entry`'s; `params` are this module's own.
//!
//! betanet's `activation` is block 970,715
//! (`000000000000000094c4b58e192ea0105c5e82c3eaf168ab53090254bc9a3c3c`), the last of 1,009
//! consecutive M2 ACKs (from 969,707) for proposal `00241a2e…f1336e86`, the fork's pinned
//! `BETANET_EXISTING_ELEMENTS_PROPOSAL_HASH` in reverse byte order (read from esplora.beta on
//! 2026-10-20). The enforcer may count the Slot as active from 970,716; to confirm with the Elements
//! dev before this ships.
//!
//! betanet's `depositConfirmations` is 6: the Elements fork returns 6 from
//! `GetDrivechainPeginConfirmationDepth` for betanet's genesis and manifest (commit `41b0dc44`,
//! "Require six confirmations for Betanet slot-24 peg-ins"), overriding the identity's
//! `PEGIN_MIN_DEPTH` of 100. `getsidechaininfo` reports it as `pegin_confirmation_depth`.
//!
//! `build.rs` picks the file: `chain-entry.json`, or `$ECX_ELEMENTS_CHAIN_ENTRY` for the e2e
//! build, whose Chain Entry differs only in its Sidechain Servers.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub use ecx_chain_entry::{AssetEntry, IdentityBlock, ServerApi, SidechainServerEntry};

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
        check_chain_entry(&entry).expect("chain-entry.json is valid");
        entry
    })
}

/// The envelope's rules, and Elements' own: a network's ECX, if it names one, is its policy asset,
/// the asset a Deposit from eCash is credited in.
pub fn check_chain_entry(entry: &ChainEntry) -> Result<(), String> {
    entry.check()?;
    for (name, network) in &entry.networks {
        if let Some(ecx) = network.ecx_asset() {
            if ecx.id != network.params.policy_asset {
                return Err(format!("{}'s {name}: its ECX must be its policy asset, {}", entry.name, network.params.policy_asset));
            }
        }
    }
    Ok(())
}
