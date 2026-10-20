//! `l1.wasm`: the L1 Chain Module behind the shared C ABI (see `ecx-wasm-abi`).
//! Thin by design: every function only decodes its inputs, calls `ecx_l1` and returns JSON.
//! It holds nothing between calls; the L1 Account Key arrives per call and is the only secret it sees.
#![allow(clippy::missing_safety_doc)]

use ecx_wasm_abi::{ret_text, text};
use serde::Serialize;

// Re-export the shared ABI so its `#[no_mangle]` functions are linked into this module.
pub use ecx_wasm_abi::{alloc, dealloc, out_clear, out_len, out_ptr};

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// The binding (chain, format, payload versions) and capabilities, as JSON.
#[no_mangle]
pub extern "C" fn declare() -> i32 {
    ret_text(json(&ecx_l1::declare()))
}

/// eCash's Chain Entry, as JSON.
#[no_mangle]
pub extern "C" fn chain_entry() -> i32 {
    ret_text(json(ecx_l1::chain_entry()))
}

/// L1 Account Key + how many receive and change addresses → the account (descriptor, addresses),
/// as JSON.
#[no_mangle]
pub unsafe extern "C" fn derive_account(key: *const u8, key_len: usize, receive: u32, change: u32) -> i32 {
    ret_text(text(key, key_len).and_then(|k| ecx_l1::derive_account(k, receive, change)).and_then(|a| json(&a)))
}
