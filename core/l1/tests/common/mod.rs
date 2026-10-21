//! What the L1 tests share: "abandon … about"'s L1 Account Key, and transactions to spend.
#![allow(dead_code)]
use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::serialize_hex;
use bitcoin::hashes::Hash;
use bitcoin::transaction::Version;
use bitcoin::{base58, Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Txid, Witness};

/// BIP84's account 0 key, `m/84'/0'/0'`, as it prints it (`zprv`).
pub const BIP84_ACCOUNT_ZPRV: &str =
    "zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE";
/// "abandon … about"'s master fingerprint.
pub const FINGERPRINT: &str = "73c5da0a";

/// The same key with the `xprv` version bytes: the L1 Account Key the Vault hands over.
pub fn account_key() -> String {
    let mut bytes = base58::decode_check(BIP84_ACCOUNT_ZPRV).unwrap();
    bytes[..4].copy_from_slice(&[0x04, 0x88, 0xad, 0xe4]);
    format!("[{FINGERPRINT}/84h/0h/0h]{}", base58::encode_check(&bytes))
}

/// BIP84's m/84'/0'/0'/0/0 and /1/0 for "abandon … about", as scripts.
pub fn receive_0() -> ScriptBuf {
    ScriptBuf::from_hex("0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2").unwrap()
}

/// betanet's Slot 24 Treasury script: `OP_NOP8 <24> OP_TRUE`.
pub fn treasury_24() -> ScriptBuf {
    ScriptBuf::from_hex("b7011851").unwrap()
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
