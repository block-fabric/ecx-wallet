//! The C ABI shared by every core module's `.wasm` (no wasm-bindgen, so no JS imports).
//!
//! Calling convention, mirrored by `wallet/src/wasm.ts`:
//! - the host copies each input into memory from `alloc(len)` and passes `(ptr, len)` pairs and
//!   plain `u32`s;
//! - every call returns `0` (ok: the result bytes) or `1` (error: a UTF-8 message), and the bytes
//!   sit in one result buffer read through `out_ptr()` / `out_len()` until the next call;
//! - the host then calls `out_clear()`, which zeroes the buffer (results can be secrets), and
//!   zeroes and `dealloc`s its inputs.
#![allow(clippy::missing_safety_doc)]

use std::ptr::addr_of_mut;

static mut OUT: Vec<u8> = Vec::new();

/// Stores a call's result in the result buffer and returns its status code.
pub fn ret(result: Result<Vec<u8>, String>) -> i32 {
    let (code, bytes) = match result {
        Ok(bytes) => (0, bytes),
        Err(message) => (1, message.into_bytes()),
    };
    clear();
    // SAFETY: wasm32 modules are single-threaded and calls never re-enter.
    unsafe { *addr_of_mut!(OUT) = bytes };
    code
}

/// [`ret`] for text results.
pub fn ret_text(result: Result<String, String>) -> i32 {
    ret(result.map(String::into_bytes))
}

/// An input the host copied in.
pub unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        return &[];
    }
    std::slice::from_raw_parts(ptr, len)
}

/// A UTF-8 input the host copied in.
pub unsafe fn text<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    std::str::from_utf8(bytes(ptr, len)).map_err(|_| "input is not UTF-8".to_string())
}

fn clear() {
    // SAFETY: as in `ret`.
    let out = unsafe { &mut *addr_of_mut!(OUT) };
    for b in out.iter_mut() {
        // Volatile so the zeroing of a buffer about to be dropped isn't optimised away.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    out.clear();
    out.shrink_to_fit();
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub unsafe extern "C" fn out_ptr() -> *const u8 {
    (*addr_of_mut!(OUT)).as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn out_len() -> usize {
    (*addr_of_mut!(OUT)).len()
}

#[no_mangle]
pub extern "C" fn out_clear() {
    clear();
}
