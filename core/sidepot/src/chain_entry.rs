//! Sidepot's Chain Entry: the one place its per-network values live (docs/adr/0021). It ships with
//! the module (embedded from `chain-entry.json`) and the wallet reads it through `chain_entry()`.
//! The envelope is `ecx-chain-entry`'s; `params` are this module's own.
//!
//! Sidepot is BIP300 Slot 88. Its state is a function of eCash's own blocks: Deposits to the Slot
//! fill game accounts, and signed entries in `OP_RETURN` outputs of ordinary eCash transactions make
//! the moves (the spec, https://sidepot.cash/rules, v0.8, read 2026-11-16).
//!
//! - **`params.anchor`:** the eCash block that mined the Slot's proposal (its M1). Every entry's
//!   signature commits to its hash and to the Slot, so an entry made for one Sidepot can't be
//!   replayed in another (a genesis hash wouldn't do: eCash's genesis is Bitcoin's).
//! - **`identityBlock`:** the anchor again. Sidepot has no blocks a server could be asked for: its
//!   chain is eCash's, whose own server passes the identity check (`core/l1/chain-entry.json`).
//!
//! **mainnet** (read from an eCash node 2026-11-17): the proposal was mined in block 982,723,
//! `00000000…72bbbf33` (the anchor), and the Slot is active from block 984,540, `00000000…c23c8904`
//! (`activation`, docs/adr/0004). `depositConfirmations` is 1: the game credits a Deposit as it reads
//! the Deposit's block. The server is the game site's API, `https://sidepot.cash/api`.
//!
//! `build.rs` picks the file: `chain-entry.json`, or `$ECX_SIDEPOT_CHAIN_ENTRY`.
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

pub use ecx_chain_entry::{AssetEntry, IdentityBlock, ServerApi, SidechainServerEntry};

/// The raw JSON, as shipped.
pub const CHAIN_ENTRY_JSON: &str = include_str!(env!("ECX_SIDEPOT_CHAIN_ENTRY_PATH"));

pub type ChainEntry = ecx_chain_entry::ChainEntry<SidepotParams>;
pub type NetworkEntry = ecx_chain_entry::NetworkEntry<SidepotParams>;

/// Sidepot's own per-network values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidepotParams {
    /// The eCash block that mined the Slot's proposal; `hash` as a node prints it.
    pub anchor: IdentityBlock,
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

/// The envelope's rules, and Sidepot's: a Slot that fits an entry's one byte, an anchor that is a
/// block hash and the network's identity block, and ECX as the native coin.
pub fn check_chain_entry(entry: &ChainEntry) -> Result<(), String> {
    entry.check()?;
    for (name, network) in &entry.networks {
        let chain = &entry.name;
        match network.slot {
            Some(slot) if u8::try_from(slot).is_ok() => {}
            _ => return Err(format!("{chain}'s {name}: its Slot must be 0 to 255")),
        }
        if crate::entry::anchor_bytes(&network.params.anchor.hash).is_none() {
            return Err(format!("{chain}'s {name}: the anchor's hash isn't 32 bytes of hex"));
        }
        if network.params.anchor != network.identity_block {
            return Err(format!("{chain}'s {name}: the identity block must be the anchor"));
        }
        if network.ecx_asset().is_some_and(|ecx| !ecx.id.is_empty()) {
            return Err(format!("{chain}'s {name}: its ECX must be the native coin, with the empty id"));
        }
    }
    Ok(())
}
