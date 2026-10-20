//! The Elements Chain Module (Slot 24, explicit-only): the reference for the Chain Module
//! interface (spec #18, "Chain Module interface").
//!
//! - [`declare`] reports the binding the module serves;
//! - [`derive_account`] turns the Slot 24 Starter into addresses and watch data.
//!
//! - [`check`] refuses, without the Starter, what the wallet must never sign;
//! - [`decode`] refuses what the wallet must never sign, and otherwise returns a Clear View (if the
//!   Decoder fully understands the request) or Blind with the facts it can prove;
//! - [`sign`] signs only the inputs that re-derive to the Starter, changing nothing else.
//!
//! The module holds nothing between calls and receives only its own Slot's Starter. Every
//! per-network value comes from Slot 24's Chain Entry (`chain-entry.json`), never from constants.
use serde::Serialize;

mod account;
mod classify;
mod clear;
mod decode;
pub mod chain_entry;
mod ownership;
mod sign;

pub use account::{derive_account, Account, AddressEntry};
pub use chain_entry::{chain_entry, ChainEntry, NetworkEntry, ServerApi, SidechainServerEntry};
pub use clear::{ClearInput, ClearOutput, ClearView, DangerousMode, Destination};
pub use decode::{check, decode, AssetAmount, Decoded, OwnedInput, Refusal, RefusalCode, VerifiableFacts};
pub use sign::sign;

/// No ambient randomness inside the module: any code path that reaches getrandom fails loudly.
#[cfg(target_arch = "wasm32")]
fn no_ambient_rng(_: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(no_ambient_rng);

/// The network this build serves (the skeleton targets betanet only).
pub const NETWORK: &str = "betanet";

/// What the module serves: requests for this chain, in this format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// CAIP-2 in our own namespace, e.g. `ecash:betanet-s24`.
    pub chain: String,
    pub format: String,
    /// Payload versions the Decoder understands.
    pub payload_versions: Vec<String>,
}

/// `declare()`'s answer: the binding plus optional capabilities (none in the skeleton).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub binding: Binding,
    pub capabilities: Vec<String>,
}

pub fn declare() -> Declaration {
    Declaration {
        binding: Binding {
            chain: network().chain.clone(),
            format: "pset".into(),
            payload_versions: vec!["1".into()],
        },
        capabilities: vec![],
    }
}

/// This build's network in Slot 24's Chain Entry.
pub fn network() -> &'static NetworkEntry {
    &chain_entry().networks[NETWORK]
}
