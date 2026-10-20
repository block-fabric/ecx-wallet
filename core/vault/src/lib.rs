//! The Vault: the only code that ever sees the Master Mnemonic.
//!
//! Pure functions, no I/O and no ambient randomness: whatever needs randomness takes it as bytes
//! from the caller. Encryption at rest and unlock state live in the TypeScript `wallet` package;
//! this crate stretches the password and derives Starters.
use bitcoin::bip32::{ChildNumber, Xpriv};
use bitcoin::hashes::{sha256, Hash};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::NetworkKind;
use unicode_normalization::UnicodeNormalization;

/// A new Master Mnemonic from the caller's entropy (16 bytes for 12 words).
pub fn master_mnemonic_from_entropy(entropy: &[u8]) -> Result<String, String> {
    Ok(bip39::Mnemonic::from_entropy(entropy).map_err(|e| e.to_string())?.to_string())
}

/// Checks a phrase the user typed and returns it in the one form the Vault stores.
pub fn canonical_mnemonic(phrase: &str) -> Result<String, String> {
    Ok(parse(phrase)?.to_string())
}

/// The Starter for `slot`: BitWindow's `DeriveStarter`.
///
/// BIP32 `m/44'/0'/<slot>'` from the Master Mnemonic's seed (with its optional passphrase), then
/// `SHA256(0x00 ‖ privkey32)[:16]` as the entropy of a 12-word BIP39 mnemonic. A Starter is
/// always used with an empty passphrase of its own.
pub fn starter(master: &str, passphrase: &str, slot: u32) -> Result<String, String> {
    let seed = parse(master)?.to_seed(passphrase); // bip39 NFKD-normalises the passphrase
    let secp = Secp256k1::signing_only();
    // The network kind only affects xprv serialisation, never the key bytes.
    let root = Xpriv::new_master(NetworkKind::Main, &seed).map_err(|e| e.to_string())?;
    let slot = ChildNumber::from_hardened_idx(slot).map_err(|_| format!("invalid slot {slot}"))?;
    let path = [ChildNumber::Hardened { index: 44 }, ChildNumber::Hardened { index: 0 }, slot];
    let key = root.derive_priv(&secp, &path).map_err(|e| e.to_string())?;

    let mut preimage = [0u8; 33];
    preimage[1..].copy_from_slice(&key.private_key.secret_bytes());
    let digest = sha256::Hash::hash(&preimage).to_byte_array();
    Ok(bip39::Mnemonic::from_entropy(&digest[..16]).map_err(|e| e.to_string())?.to_string())
}

/// Argon2id cost parameters. Stored next to the ciphertext so they can be raised later.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory in KiB.
    pub m_kib: u32,
    /// Iterations.
    pub t: u32,
    /// Parallelism.
    pub p: u32,
}

impl KdfParams {
    /// 64 MiB, 3 passes, 1 lane: about 0.1 s in the browser's WASM.
    pub const DEFAULT: KdfParams = KdfParams { m_kib: 65536, t: 3, p: 1 };
}

/// The 32-byte vault key: Argon2id (v1.3) of the password under `salt` (at least 8 bytes).
pub fn stretch_password(password: &[u8], salt: &[u8], params: KdfParams) -> Result<[u8; 32], String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(params.m_kib, params.t, params.p, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

/// Parses a phrase the way BitWindow's `NormalizeMnemonic` reads it: NFKD, lower case, any run of
/// whitespace as one space. The BIP39 checksum must hold.
fn parse(phrase: &str) -> Result<bip39::Mnemonic, String> {
    let normalized: String = phrase.nfkd().collect::<String>().to_lowercase();
    let words: Vec<&str> = normalized.split_whitespace().collect();
    bip39::Mnemonic::parse_in(bip39::Language::English, words.join(" ")).map_err(|e| e.to_string())
}
