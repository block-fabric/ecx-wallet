//! Fixture PSETs for Seam 2 (and, through `fixtures.rs`, for the e2e suite), built offline.
//!
//! Keys come from the public descriptor `derive_account` returns, so a fixture input "belongs" to a
//! Starter exactly as a Sidechain Server would describe it: fingerprint, path, pubkey, script.
#![allow(dead_code)]

use std::str::FromStr;

use ecx_elements::{derive_account, network};
use elements_miniscript::bitcoin::bip32::{DerivationPath, Fingerprint};
use elements_miniscript::elements::confidential::{Asset, Nonce, Value};
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::pset::raw::ProprietaryKey;
use elements_miniscript::elements::pset::{Input, Output, PartiallySignedTransaction};
use elements_miniscript::elements::{AssetId, BlockHash, OutPoint, Script, TxOut, TxOutWitness, Txid};
use elements_miniscript::{Descriptor, DescriptorPublicKey, ForEachKey, ToPublicKey};

/// The Slot 24 Starter of "abandon … about", no passphrase (the e2e wallet).
pub const STARTER: &str = "buyer citizen congress doll secret merry denial law live wait pass drive";
/// Some other wallet's Starter.
pub const FOREIGN: &str = "blush cream bullet drive index disease noble east target dice put rate";

pub type Pset = PartiallySignedTransaction;
pub type PublicKey = elements_miniscript::bitcoin::PublicKey;

/// One wallet key as a PSET describes it.
#[derive(Clone)]
pub struct Key {
    pub pk: PublicKey,
    pub fingerprint: Fingerprint,
    pub path: DerivationPath,
    pub script_pubkey: Script,
}

/// `starter`'s key at `<chain>/<index>` of its `elwpkh` account.
pub fn key(starter: &str, chain: u32, index: u32) -> Key {
    let desc = Descriptor::<DescriptorPublicKey>::from_str(&derive_account(starter, 0).unwrap().descriptor).unwrap();
    let single = desc.into_single_descriptors().unwrap().swap_remove(chain as usize);
    let at = single.at_derivation_index(index).unwrap();
    let mut found = None;
    at.for_each_key(|k| {
        found = Some((k.to_public_key(), k.master_fingerprint(), k.full_derivation_path().unwrap()));
        true
    });
    let (pk, fingerprint, path) = found.unwrap();
    Key { pk, fingerprint, path, script_pubkey: at.script_pubkey() }
}

pub fn policy_asset() -> AssetId {
    AssetId::from_str(&network().policy_asset).unwrap()
}

/// The ELIP-101 global field (display hex → internal byte order).
pub fn set_genesis(pset: &mut Pset, display_hex: &str) {
    let hash = BlockHash::from_str(display_hex).unwrap();
    pset.global.proprietary.insert(ProprietaryKey::from_pset_pair(0x02, vec![]), hash.to_byte_array().to_vec());
}

pub fn new_pset() -> Pset {
    let mut pset = Pset::new_v2();
    set_genesis(&mut pset, &network().genesis_hash);
    pset
}

/// An explicit policy-asset UTXO paying `key`, with `witness_utxo` and `bip32_derivation`.
pub fn input(key: &Key, value: u64, prev: u8) -> Input {
    let mut inp = Input::from_prevout(OutPoint::new(Txid::from_byte_array([prev; 32]), 0));
    inp.witness_utxo = Some(TxOut {
        asset: Asset::Explicit(policy_asset()),
        value: Value::Explicit(value),
        nonce: Nonce::Null,
        script_pubkey: key.script_pubkey.clone(),
        witness: TxOutWitness::default(),
    });
    inp.bip32_derivation.insert(key.pk, (key.fingerprint, key.path.clone()));
    inp
}

pub fn pay(script_pubkey: Script, value: u64) -> Output {
    Output::new_explicit(script_pubkey, value, policy_asset(), None)
}

/// An output back to a wallet key, carrying its derivation so the wallet can re-derive it.
pub fn change(key: &Key, value: u64) -> Output {
    let mut out = pay(key.script_pubkey.clone(), value);
    out.bip32_derivation.insert(key.pk, (key.fingerprint, key.path.clone()));
    out
}

pub fn fee(value: u64) -> Output {
    pay(Script::new(), value)
}

/// One owned input (100 000) and one foreign input (50 000), paying a foreign address 120 000,
/// 29 000 change back to us, and a 1 000 fee.
pub fn transfer() -> Pset {
    let mut pset = new_pset();
    pset.add_input(input(&key(STARTER, 0, 0), 100_000, 1));
    pset.add_input(input(&key(FOREIGN, 0, 0), 50_000, 2));
    pset.add_output(pay(key(FOREIGN, 0, 1).script_pubkey, 120_000));
    pset.add_output(change(&key(STARTER, 1, 0), 29_000));
    pset.add_output(fee(1_000));
    pset
}

pub fn b64(pset: &Pset) -> String {
    pset.to_string()
}

pub fn parse(b64: &str) -> Pset {
    Pset::from_str(b64).unwrap()
}

/// `starter`'s key at an arbitrary `path` (outside its account), with a p2wpkh script.
pub fn key_at_path(starter: &str, path: &str) -> Key {
    use lwk_common::Signer;
    let signer = lwk_signer::SwSigner::new(starter, false).unwrap();
    let path = DerivationPath::from_str(path).unwrap();
    let xpub = signer.derive_xpub(&path).unwrap();
    let pk = PublicKey::new(xpub.public_key);
    let wpkh = elements_miniscript::elements::WPubkeyHash::from_byte_array(pk.wpubkey_hash().unwrap().to_byte_array());
    Key { pk, fingerprint: signer.fingerprint(), path, script_pubkey: Script::new_v0_wpkh(&wpkh) }
}

/// `transfer()` plus fields the Decoder doesn't know: an unknown global, input and output key,
/// and a foreign proprietary input field.
pub fn transfer_with_unknown_fields() -> Pset {
    use elements_miniscript::elements::pset::raw;
    let mut pset = transfer();
    pset.global.unknown.insert(raw::Key { type_value: 0xf0, key: vec![0xaa] }, vec![1, 2, 3]);
    pset.inputs_mut()[0].unknown.insert(raw::Key { type_value: 0xf1, key: vec![] }, vec![0xde, 0xad, 0xbe, 0xef]);
    pset.inputs_mut()[0]
        .proprietary
        .insert(ProprietaryKey { prefix: b"acme".to_vec(), subtype: 7, key: vec![9] }, vec![0x42; 5]);
    pset.outputs_mut()[0].unknown.insert(raw::Key { type_value: 0xf2, key: vec![0xbb, 0xcc] }, vec![7; 40]);
    pset
}

/// `transfer()` whose foreign input's UTXO has a confidential (committed) value.
pub fn with_confidential_input() -> Pset {
    use elements_miniscript::elements::secp256k1_zkp::{Generator, PedersenCommitment, Secp256k1};
    let secp = Secp256k1::new();
    let generator = Generator::new_unblinded(&secp, policy_asset().into_tag());
    let mut pset = transfer();
    let utxo = pset.inputs_mut()[1].witness_utxo.as_mut().unwrap();
    utxo.value = Value::Confidential(PedersenCommitment::new_unblinded(&secp, 50_000, generator));
    pset
}

/// `transfer()` whose foreign payment carries a blinding key (it is meant to be blinded).
pub fn with_confidential_output() -> Pset {
    let mut pset = transfer();
    pset.outputs_mut()[0].blinding_key = Some(key(FOREIGN, 0, 1).pk);
    pset.outputs_mut()[0].blinder_index = Some(0);
    pset
}

/// `transfer()` whose foreign input doesn't say whose key it needs.
pub fn with_missing_derivation() -> Pset {
    let mut pset = transfer();
    pset.inputs_mut()[1].bip32_derivation.clear();
    pset
}

/// A native-withdrawal (peg-out) burn script: OP_RETURN <parent genesis> <L1 script> <fee, BE u64>.
pub fn peg_out_burn_script() -> Script {
    use elements_miniscript::elements::opcodes::all::OP_RETURN;
    use elements_miniscript::elements::script::Builder;
    let parent = BlockHash::from_str(&network().parent_genesis_hash).unwrap();
    let l1_p2wpkh = [&[0x00, 0x14][..], &[0x11; 20]].concat();
    Builder::new()
        .push_opcode(OP_RETURN)
        .push_slice(parent.as_byte_array())
        .push_slice(&l1_p2wpkh)
        .push_slice(&1_000u64.to_be_bytes())
        .into_script()
}
