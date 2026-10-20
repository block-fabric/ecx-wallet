//! `vault.wasm`: the Vault behind the shared C ABI (see `ecx-wasm-abi`). Thin by design: every
//! function only decodes its inputs and calls `ecx_vault`.
#![allow(clippy::missing_safety_doc)]

use ecx_vault::KdfParams;
use ecx_wasm_abi::{bytes, ret, ret_text, text};

// Re-export the shared ABI so its `#[no_mangle]` functions are linked into this module.
pub use ecx_wasm_abi::{alloc, dealloc, out_clear, out_len, out_ptr};

/// Entropy (from the host's CSPRNG) → a new Master Mnemonic.
#[no_mangle]
pub unsafe extern "C" fn master_mnemonic_from_entropy(entropy: *const u8, entropy_len: usize) -> i32 {
    ret_text(ecx_vault::master_mnemonic_from_entropy(bytes(entropy, entropy_len)))
}

/// A typed phrase → its canonical form, or an error if it isn't a valid BIP39 phrase.
#[no_mangle]
pub unsafe extern "C" fn canonical_mnemonic(phrase: *const u8, phrase_len: usize) -> i32 {
    ret_text(text(phrase, phrase_len).and_then(ecx_vault::canonical_mnemonic))
}

/// Master Mnemonic + passphrase + Slot → that Slot's Starter.
#[no_mangle]
pub unsafe extern "C" fn starter(
    master: *const u8,
    master_len: usize,
    passphrase: *const u8,
    passphrase_len: usize,
    slot: u32,
) -> i32 {
    ret_text(
        text(master, master_len)
            .and_then(|m| text(passphrase, passphrase_len).map(|p| (m, p)))
            .and_then(|(m, p)| ecx_vault::starter(m, p, slot)),
    )
}

/// Master Mnemonic + passphrase → the L1 Account Key.
#[no_mangle]
pub unsafe extern "C" fn l1_account_key(master: *const u8, master_len: usize, passphrase: *const u8, passphrase_len: usize) -> i32 {
    ret_text(
        text(master, master_len)
            .and_then(|m| text(passphrase, passphrase_len).map(|p| (m, p)))
            .and_then(|(m, p)| ecx_vault::l1_account_key(m, p)),
    )
}

/// Password + salt → the 32-byte vault key (Argon2id).
#[no_mangle]
pub unsafe extern "C" fn stretch_password(
    password: *const u8,
    password_len: usize,
    salt: *const u8,
    salt_len: usize,
    m_kib: u32,
    t: u32,
    p: u32,
) -> i32 {
    ret(ecx_vault::stretch_password(bytes(password, password_len), bytes(salt, salt_len), KdfParams { m_kib, t, p })
        .map(|key| key.to_vec()))
}
