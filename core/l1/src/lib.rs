//! The L1 (eCash) Chain Module: the root chain's module (docs/adr/0003).
//!
//! - [`declare`] reports the binding the module serves;
//! - [`derive_account`] turns the L1 Account Key into BIP84 (P2WPKH) addresses and watch data.
//!
//! It receives the L1 Account Key, `[fingerprint/84h/0h/0h]xprv…` (the Vault's `l1_account_key`),
//! and never a Starter or the Master Mnemonic. It holds nothing between calls. Every per-network
//! value comes from eCash's Chain Entry (`chain-entry.json`), never from constants. Signing and
//! deposits come with the Deposit issue (#31).
use std::str::FromStr;

use bitcoin::bech32::{self, Hrp};
use bitcoin::bip32::{ChildNumber, DerivationPath, Fingerprint, Xpriv, Xpub};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::CompressedPublicKey;
use serde::Serialize;

pub mod chain_entry;

pub use chain_entry::{chain_entry, ChainEntry, NetworkEntry, ServerApi, SidechainServerEntry};

/// The network this build serves (betanet only, until mainnet: #32).
pub const NETWORK: &str = "betanet";

/// The account path the L1 Account Key sits at: BIP84, coin type 0 (ECX shares Bitcoin's keys), account 0.
pub const ACCOUNT_PATH: &str = "84h/0h/0h";

/// What the module serves: requests for this chain, in this format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// CAIP-2, e.g. `ecash:betanet`.
    pub chain: String,
    pub format: String,
    /// Payload versions the Decoder understands: none yet, it decodes nothing.
    pub payload_versions: Vec<String>,
}

/// `declare()`'s answer: the binding plus optional capabilities (none).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub binding: Binding,
    pub capabilities: Vec<String>,
}

pub fn declare() -> Declaration {
    Declaration {
        binding: Binding { chain: network().chain.clone(), format: "psbt".into(), payload_versions: vec![] },
        capabilities: vec![],
    }
}

/// This build's network in eCash's Chain Entry.
pub fn network() -> &'static NetworkEntry {
    &chain_entry().networks[NETWORK]
}

/// Addresses and watch data for the L1 Account Key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Watch data: the public descriptor (fingerprint + xpub, both chains).
    pub descriptor: String,
    /// External (receive) addresses, from index 0.
    pub receive: Vec<AddressEntry>,
    /// Internal (change) addresses, from index 0.
    pub change: Vec<AddressEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressEntry {
    pub index: u32,
    pub address: String,
    /// Hex.
    pub script_pubkey: String,
}

/// The L1 Account Key → its account's descriptor, its first `receive_count` receive addresses and
/// its first `change_count` change addresses.
pub fn derive_account(account_key: &str, receive_count: u32, change_count: u32) -> Result<Account, String> {
    let (fingerprint, xprv) = parse_account_key(account_key)?;
    let secp = Secp256k1::new();
    let xpub = Xpub::from_priv(&secp, &xprv);
    let descriptor = format!("wpkh([{fingerprint}/{ACCOUNT_PATH}]{xpub}/<0;1>/*)");

    let hrp = Hrp::parse(&network().params.address_params.bech_hrp).expect("Chain Entry bech HRP is valid");
    let addresses = |chain: u32, count: u32| {
        (0..count)
            .map(|index| {
                let path = [ChildNumber::Normal { index: chain }, ChildNumber::Normal { index }];
                let key = xpub.derive_pub(&secp, &path).map_err(|e| e.to_string())?;
                let program = CompressedPublicKey(key.public_key).wpubkey_hash();
                let address = bech32::segwit::encode_v0(hrp, program.as_ref()).map_err(|e| e.to_string())?;
                let mut script = vec![0x00, 0x14];
                script.extend_from_slice(program.as_ref());
                Ok(AddressEntry { index, address, script_pubkey: hex(&script) })
            })
            .collect::<Result<Vec<_>, String>>()
    };
    Ok(Account { descriptor, receive: addresses(0, receive_count)?, change: addresses(1, change_count)? })
}

/// `[fingerprint/84h/0h/0h]xprv…` → the master fingerprint and the account xprv. Anything else (a
/// Starter, a bare xprv, another path) is refused.
fn parse_account_key(account_key: &str) -> Result<(Fingerprint, Xpriv), String> {
    let invalid = || "invalid L1 Account Key: expected [fingerprint/84h/0h/0h]xprv…".to_string();
    let (origin, key) = account_key.strip_prefix('[').and_then(|rest| rest.split_once(']')).ok_or_else(invalid)?;
    let (fingerprint, path) = origin.split_once('/').ok_or_else(invalid)?;
    let fingerprint = Fingerprint::from_str(fingerprint).map_err(|_| invalid())?;
    let expected = DerivationPath::from_str(&format!("m/{ACCOUNT_PATH}")).expect("valid path");
    if DerivationPath::from_str(&format!("m/{path}")).map_err(|_| invalid())? != expected {
        return Err(invalid());
    }
    let xprv = Xpriv::from_str(key).map_err(|_| invalid())?;
    if xprv.depth != 3 || xprv.child_number != expected[2] {
        return Err(invalid());
    }
    Ok((fingerprint, xprv))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
