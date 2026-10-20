//! `elements.wasm`: the Elements Chain Module behind the shared C ABI (see `ecx-wasm-abi`).
//! Thin by design: every function only decodes its inputs, calls `ecx_elements` and returns JSON.
//! It holds nothing between calls; the Starter arrives per call and is the only secret it sees.
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
    ret_text(json(&ecx_elements::declare()))
}

/// Slot 24's Chain Entry, as JSON.
#[no_mangle]
pub extern "C" fn chain_entry() -> i32 {
    ret_text(json(ecx_elements::chain_entry()))
}

/// Slot 24 Starter + how many receive addresses → the account (descriptor, addresses), as JSON.
#[no_mangle]
pub unsafe extern "C" fn derive_account(starter: *const u8, starter_len: usize, receive: u32) -> i32 {
    ret_text(text(starter, starter_len).and_then(|s| ecx_elements::derive_account(s, receive)).and_then(|a| json(&a)))
}
