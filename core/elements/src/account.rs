//! `deriveAccount(starter, …)`: LWK's standard single-sig layout under the Starter, explicit-only.
//!
//! - master key: `SwSigner::new(starter, false)`, i.e. BIP39 seed with an empty passphrase, testnet
//!   keys (`tpub`);
//! - path: LWK's non-mainnet default `m/84'/1'/0'` (provisional, spec #18 "Further Notes");
//! - descriptor: `elwpkh([fp/84h/1h/0h]tpub…/<0;1>/*)`: LWK's `ct(slip77(..), …)` without the
//!   blinding key, which the explicit-only wallet doesn't need.
//!
//! Address strings use the Chain Entry's address parameters (`elements1…`), never LWK's built-in
//! `ert`/`el` ones.
use std::str::FromStr;
use std::sync::OnceLock;

use elements_miniscript::bitcoin::bip32::DerivationPath;
use elements_miniscript::elements::AddressParams;
use elements_miniscript::{Descriptor, DescriptorPublicKey};
use lwk_common::Signer;
use lwk_signer::SwSigner;
use serde::Serialize;

use crate::network;

/// LWK's single-sig account path off mainnet (`lwk_common::singlesig_desc`, coin type 1).
pub(crate) const ACCOUNT_PATH: &str = "84h/1h/0h";

/// Addresses and watch data for one Starter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Watch data for the Sidechain Server: the public descriptor (fingerprint + xpub, both chains).
    pub descriptor: String,
    /// External (receive) addresses, from index 0.
    pub receive: Vec<AddressEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressEntry {
    pub index: u32,
    pub address: String,
    /// Hex.
    pub script_pubkey: String,
}

/// The Starter → its account's descriptor and its first `receive_count` receive addresses.
pub fn derive_account(starter: &str, receive_count: u32) -> Result<Account, String> {
    let signer = SwSigner::new(starter, false).map_err(|e| format!("invalid Starter: {e}"))?;
    let path = DerivationPath::from_str(&format!("m/{ACCOUNT_PATH}")).expect("valid path");
    let xpub = signer.derive_xpub(&path).map_err(|e| format!("derive xpub: {e:?}"))?;
    let descriptor = format!("elwpkh([{}/{ACCOUNT_PATH}]{xpub}/<0;1>/*)", signer.fingerprint());

    let parsed = Descriptor::<DescriptorPublicKey>::from_str(&descriptor).map_err(|e| e.to_string())?;
    let external = parsed.into_single_descriptors().map_err(|e| e.to_string())?.swap_remove(0);
    let receive = (0..receive_count)
        .map(|index| {
            let at = external.at_derivation_index(index).map_err(|e| e.to_string())?;
            let address = at.address(address_params()).map_err(|e| e.to_string())?;
            Ok(AddressEntry {
                index,
                address: address.to_string(),
                script_pubkey: hex(at.script_pubkey().as_bytes()),
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(Account { descriptor, receive })
}

/// The Chain Entry's address parameters, as rust-elements wants them (`&'static`).
pub(crate) fn address_params() -> &'static AddressParams {
    static PARAMS: OnceLock<AddressParams> = OnceLock::new();
    PARAMS.get_or_init(|| {
        let p = &network().address_params;
        AddressParams {
            p2pkh_prefix: p.p2pkh_prefix,
            p2sh_prefix: p.p2sh_prefix,
            blinded_prefix: p.blinded_prefix,
            bech_hrp: bech32::Hrp::parse(&p.bech_hrp).expect("Chain Entry bech HRP is valid"),
            blech_hrp: bech32::Hrp::parse(&p.blech_hrp).expect("Chain Entry blech HRP is valid"),
        }
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
