//! `sidepot.wasm`: the Sidepot Chain Module behind the shared C ABI (see `ecx-wasm-abi`).
//! Thin by design: every function only decodes its inputs, calls `ecx_sidepot` and returns JSON.
//! It holds nothing between calls; Sidepot's Starter arrives per call and is the only secret it sees.
#![allow(clippy::missing_safety_doc)]

use ecx_wasm_abi::{ret_text, text};
use serde::Serialize;

// Re-export the shared ABI so its `#[no_mangle]` functions are linked into this module.
pub use ecx_wasm_abi::{alloc, dealloc, out_clear, out_len, out_ptr};

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// A refusal travels as the error result, as JSON (`{ code, message }`), so the host can tell
/// which rule refused the request.
fn refusal(r: ecx_sidepot::Refusal) -> String {
    json(&r).unwrap_or(r.message)
}

/// The binding (chain, format, payload versions) and capabilities, as JSON.
#[no_mangle]
pub extern "C" fn declare() -> i32 {
    ret_text(json(&ecx_sidepot::declare()))
}

/// Sidepot's Chain Entry, as JSON.
#[no_mangle]
pub extern "C" fn chain_entry() -> i32 {
    ret_text(json(ecx_sidepot::chain_entry()))
}

/// Starter + how many receive and change addresses → the game account (`spot:<x-only key>`, once), as JSON.
#[no_mangle]
pub unsafe extern "C" fn derive_account(starter: *const u8, starter_len: usize, receive: u32, change: u32) -> i32 {
    ret_text(text(starter, starter_len).and_then(|s| ecx_sidepot::derive_account(s, receive, change)).and_then(|a| json(&a)))
}

/// Starter → what a Deposit to the Slot is credited to (`{ address, destination, asset, minimum }`), as JSON.
#[no_mangle]
pub unsafe extern "C" fn deposit_destination(starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(starter, starter_len).and_then(ecx_sidepot::deposit_destination).and_then(|d| json(&d)))
}

/// A `sidepot:` action link → what it asks for, as JSON, or a refusal. Needs no Starter.
#[no_mangle]
pub unsafe extern "C" fn parse_entry(link: *const u8, link_len: usize) -> i32 {
    ret_text(text(link, link_len).and_then(|l| ecx_sidepot::parse_entry(l).map_err(refusal).and_then(|v| json(&v))))
}

/// A `sidepot:` action link + Starter → `{ entry, view }` (the signed entry, hex, and what it says)
/// as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn sign_entry(link: *const u8, link_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(link, link_len).and_then(|l| {
        let s = text(starter, starter_len)?;
        ecx_sidepot::sign_entry(l, s).map_err(refusal).and_then(|e| json(&e))
    }))
}

/// Starter → the wallet's Sidepot sidechain address (`{ address, hex, publicKey }`), as JSON (docs/adr/0022).
#[no_mangle]
pub unsafe extern "C" fn coin_address(starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(starter, starter_len).and_then(ecx_sidepot::coin_address).and_then(|a| json(&a)))
}

/// A spend order (JSON: the address's coins, what to pay, the fee) + Starter → `{ payload, spent }`
/// (the unsigned spend and the outpoints it spends) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn build_coin_spend(order: *const u8, order_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(order, order_len).and_then(|o| {
        let s = text(starter, starter_len)?;
        ecx_sidepot::build_spend(o, s).map_err(refusal).and_then(|b| json(&b))
    }))
}

/// An unsigned spend + Starter → what it does (`{ kind: "clear", view }`) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn decode_coin_spend(payload: *const u8, payload_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let s = text(starter, starter_len)?;
        ecx_sidepot::decode_spend(p, s).map_err(refusal).and_then(|d| json(&d))
    }))
}

/// An unsigned spend + Starter → `{ tx, txid }` (the signed transaction as the node takes it, and
/// its txid) as JSON, or a refusal.
#[no_mangle]
pub unsafe extern "C" fn sign_coin_spend(payload: *const u8, payload_len: usize, starter: *const u8, starter_len: usize) -> i32 {
    ret_text(text(payload, payload_len).and_then(|p| {
        let s = text(starter, starter_len)?;
        ecx_sidepot::sign_spend(p, s).map_err(refusal).and_then(|d| json(&d))
    }))
}

// The rest of a Chain Module's interface: Sidepot has no Signing Requests, so each refuses. Its coins'
// spends are the wallet's own, built above, never a payload someone else sends.

#[no_mangle]
pub unsafe extern "C" fn check(_payload: *const u8, _payload_len: usize) -> i32 {
    ret_text(Err(refusal(ecx_sidepot::no_signing_requests())))
}

#[no_mangle]
pub unsafe extern "C" fn decode(
    _payload: *const u8,
    _payload_len: usize,
    _starter: *const u8,
    _starter_len: usize,
    _evidence: *const u8,
    _evidence_len: usize,
) -> i32 {
    ret_text(Err(refusal(ecx_sidepot::no_signing_requests())))
}

#[no_mangle]
pub unsafe extern "C" fn sign(_payload: *const u8, _payload_len: usize, _starter: *const u8, _starter_len: usize) -> i32 {
    ret_text(Err(refusal(ecx_sidepot::no_signing_requests())))
}

#[no_mangle]
pub unsafe extern "C" fn finalize(_payload: *const u8, _payload_len: usize) -> i32 {
    ret_text(Err(refusal(ecx_sidepot::no_signing_requests())))
}
