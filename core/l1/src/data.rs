//! `build_data(order, account_key)`: an L1 transaction that carries data and pays nothing but its
//! fee (docs/adr/0021), as an unsigned PSBT for the normal review. What a Slot whose moves are read
//! from eCash's own blocks needs: Sidepot's entries.
//!
//! - Outputs: one `OP_RETURN` with the data in a single push, value 0, then change as a Send's.
//! - Inputs, fee, change and the replay marker: exactly a Send's ([`crate::transfer::funded`]).
//!
//! The module doesn't read the data: the Slot's own Chain Module made it, and the wallet checks the
//! Clear View carries those bytes and nothing else leaves.
use bitcoin::script::PushBytesBuf;
use bitcoin::{Amount, ScriptBuf, TxOut};
use serde::Deserialize;

use crate::deposit::{malformed, Coin};
use crate::psbt::{refuse, Refusal, RefusalCode};
use crate::transfer::{funded, BuiltTransfer};
use crate::AccountKeys;

/// The most data bytes: what one `OP_PUSHDATA1` holds. From 76 bytes up the push is an
/// `OP_PUSHDATA1`, as Sidepot reads its 128- and 142-byte entries.
pub const MAX_DATA_BYTES: usize = 255;

/// The data to carry, and what to pay its fee from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataOrder {
    /// The account's coins to choose from (the wallet's rule: confirmed or trusted, none held back).
    pub coins: Vec<Coin>,
    /// Hex: 1 to 255 bytes.
    pub data: String,
    /// Sats per 1000 vbytes.
    pub fee_rate: u64,
    /// The change address's index (the account's first unused one, else its last).
    pub change_index: u32,
}

/// `OP_RETURN <data>`, the data in one minimal push; None unless it is 1 to [`MAX_DATA_BYTES`] bytes.
pub(crate) fn data_script(data: &[u8]) -> Option<ScriptBuf> {
    if data.is_empty() || data.len() > MAX_DATA_BYTES {
        return None;
    }
    Some(ScriptBuf::new_op_return(PushBytesBuf::try_from(data.to_vec()).ok()?))
}

pub fn build_data(order_json: &str, account_key: &str) -> Result<BuiltTransfer, Refusal> {
    let order: DataOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid data order: {e}")))?;
    let keys = AccountKeys::new(account_key).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    let script = (bitcoin::hex::FromHex::from_hex(&order.data).ok() as Option<Vec<u8>>)
        .and_then(|data| data_script(&data))
        .ok_or_else(|| malformed(format!("The data must be 1 to {MAX_DATA_BYTES} bytes of hex.")))?;
    funded(vec![TxOut { value: Amount::ZERO, script_pubkey: script }], &order.coins, order.fee_rate, order.change_index, &keys)
}
