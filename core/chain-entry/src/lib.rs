//! The Chain Entry (docs/adr/0003): the description of one chain of the tree, eCash itself or a
//! sidechain, that ships compiled into that chain's module. The envelope is the same for every
//! chain; `params` is the module's own and only it reads them.
//!
//! The root (eCash) has neither `slot` nor `parent`; every other chain has both: its BIP300 Slot is
//! its number under its parent.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainEntry<P> {
    /// The chain's Slot under its parent; absent for the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
    pub name: String,
    pub networks: BTreeMap<String, NetworkEntry<P>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkEntry<P> {
    /// CAIP-2 chain id: `ecash:<network>` for the root, `ecash:<network>-s<slot>` under it.
    pub chain: String,
    /// The parent chain's `chain`; absent for the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// The block a server must have to be on this chain: the identity check (docs/adr/0003).
    pub identity_block: IdentityBlock,
    /// The parent-chain block whose M2 activated this chain's Slot, pinned once checked. Only a
    /// chain with a parent has one. Without it, the wallet refuses a deposit while the Slot has no
    /// Treasury (docs/adr/0004).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<IdentityBlock>,
    /// The default Sidechain Server and the Server API the wallet speaks to it.
    pub sidechain_server: SidechainServerEntry,
    /// Official App origins (placeholder).
    pub official_apps: Vec<String>,
    /// The module's own per-network values.
    pub params: P,
}

/// A block by height and hash (display hex). Height 0 (the genesis) unless the chain is a fork, whose
/// genesis is its ancestor's: then the first block after the fork.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityBlock {
    pub height: u32,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SidechainServerEntry {
    pub api: ServerApi,
    /// Base URL; the extension build grants itself access to its origin and nothing else.
    pub url: String,
}

/// The protocol the wallet speaks to a Sidechain Server (docs/adr/0002). No default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerApi {
    /// The Standard Sidechain API (`stub-server/README.md`).
    #[serde(rename = "ecx-v0")]
    EcxV0,
    /// The Esplora REST API, the subset both electrs forks serve.
    #[serde(rename = "esplora")]
    Esplora,
}

impl<P> ChainEntry<P> {
    /// The rules one entry can check alone: `slot` and every network's `parent` are both present or
    /// both absent. That every `parent` exists is checked across entries, by the wallet's tests.
    pub fn check(&self) -> Result<(), String> {
        for (name, network) in &self.networks {
            if self.slot.is_some() != network.parent.is_some() {
                return Err(format!("{}'s {name}: a chain has both a slot and a parent, or neither", self.name));
            }
            if !is_block_hash(&network.identity_block.hash) {
                return Err(format!("{}'s {name}: the identity block hash isn't 32 bytes of hex", self.name));
            }
            match &network.activation {
                Some(_) if network.parent.is_none() => {
                    return Err(format!("{}'s {name}: only a chain with a parent has an activation block", self.name))
                }
                Some(activation) if !is_block_hash(&activation.hash) => {
                    return Err(format!("{}'s {name}: the activation block hash isn't 32 bytes of hex", self.name))
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn is_block_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(slot: Option<u32>, parent: Option<&str>) -> ChainEntry<()> {
        let network = NetworkEntry {
            chain: "ecash:betanet".into(),
            parent: parent.map(Into::into),
            identity_block: IdentityBlock { height: 0, hash: "00".repeat(32) },
            activation: None,
            sidechain_server: SidechainServerEntry { api: ServerApi::Esplora, url: "https://example.invalid".into() },
            official_apps: vec![],
            params: (),
        };
        ChainEntry { slot, name: "Test".into(), networks: [("betanet".into(), network)].into() }
    }

    #[test]
    fn a_chain_has_a_slot_and_a_parent_or_neither() {
        assert!(entry(None, None).check().is_ok());
        assert!(entry(Some(24), Some("ecash:betanet")).check().is_ok());
        assert!(entry(Some(24), None).check().is_err());
        assert!(entry(None, Some("ecash:betanet")).check().is_err());
    }

    #[test]
    fn only_a_chain_with_a_parent_has_an_activation_block() {
        let activation = || Some(IdentityBlock { height: 970_715, hash: "11".repeat(32) });
        let mut child = entry(Some(24), Some("ecash:betanet"));
        child.networks.get_mut("betanet").unwrap().activation = activation();
        assert!(child.check().is_ok());
        let mut root = entry(None, None);
        root.networks.get_mut("betanet").unwrap().activation = activation();
        assert!(root.check().is_err());
        child.networks.get_mut("betanet").unwrap().activation = Some(IdentityBlock { height: 1, hash: "xx".into() });
        assert!(child.check().is_err());
    }
}
