//! What the Flush tests share: a Starter, another wallet's, and transactions to spend.
#![allow(dead_code)]
use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};

/// The Slot 24 Starter of "abandon … about", no passphrase: the Elements tests' vectors were
/// derived from it, so the same keys show up here at the same path.
pub const STARTER: &str = "buyer citizen congress doll secret merry denial law live wait pass drive";
/// Some other wallet's Starter.
pub const FOREIGN: &str = "blush cream bullet drive index disease noble east target dice put rate";

/// The script of the Starter's `chain`/`index` address.
pub fn script(starter: &str, chain: u32, index: u32) -> ScriptBuf {
    let account = ecx_flush::derive_account(starter, index + 1, index + 1).unwrap();
    let entry = if chain == 0 { &account.receive[index as usize] } else { &account.change[index as usize] };
    ScriptBuf::from_hex(&entry.script_pubkey).unwrap()
}

/// The address of the Starter's `chain`/`index`.
pub fn address(starter: &str, chain: u32, index: u32) -> String {
    let account = ecx_flush::derive_account(starter, index + 1, index + 1).unwrap();
    let entry = if chain == 0 { &account.receive[index as usize] } else { &account.change[index as usize] };
    entry.address.clone()
}

/// A transaction paying `outputs`, from a made-up input (`seed` keeps the txids apart).
pub fn paying(seed: u8, outputs: &[(&ScriptBuf, u64)]) -> Transaction {
    Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint { txid: Txid::from_byte_array([seed; 32]), vout: 0 },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: outputs.iter().map(|(script, value)| TxOut { script_pubkey: (*script).clone(), value: Amount::from_sat(*value) }).collect(),
    }
}

pub fn tx_hex(tx: &Transaction) -> String {
    serialize_hex(tx)
}
