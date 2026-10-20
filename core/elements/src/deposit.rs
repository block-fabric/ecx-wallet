//! `deposit_destination(starter)`: what a Deposit to Slot 24 is credited to, in the bytes an M5's
//! `OP_RETURN` carries, and the chain's rules for it (#15, #31).
//!
//! The fork reads the destination as an Elements address (`ExtractDepositDestination` at
//! `57ff4a8`): the bare UTF-8 `elements1…` string, at most 128 bytes (`depositAddressLimit`). The
//! credit is exactly the deposit's value (`importdrivechaindeposit` takes no fee from it), so there
//! is no credit fee to declare.
use serde::Serialize;

use crate::account::derive_account;
use crate::network;

/// The fork's `depositAddressLimit`.
const MAX_DESTINATION_BYTES: usize = 128;

/// The smallest Deposit, in sats: a Treasury output never below Bitcoin's dust limit for it.
const MINIMUM_DEPOSIT: u64 = 3000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositDestination {
    /// The Starter's first receive address, which the Deposit is credited to.
    pub address: String,
    /// The bytes the M5's `OP_RETURN` pushes, hex.
    pub destination: String,
    /// The asset the credit arrives in (display hex): the pegged asset.
    pub asset: String,
    /// Sats, as a decimal string: the smallest Deposit the wallet builds.
    pub minimum: String,
}

pub fn deposit_destination(starter: &str) -> Result<DepositDestination, String> {
    let address = derive_account(starter, 1, 0)?.receive.remove(0).address;
    if address.len() > MAX_DESTINATION_BYTES {
        return Err(format!("{address} is longer than a Deposit's {MAX_DESTINATION_BYTES}-byte destination"));
    }
    let destination = address.bytes().map(|b| format!("{b:02x}")).collect();
    Ok(DepositDestination { address, destination, asset: network().params.policy_asset.clone(), minimum: MINIMUM_DEPOSIT.to_string() })
}
