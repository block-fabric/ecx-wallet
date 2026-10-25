//! `build_transfer(order, starter)`: the wallet's own Send of ECX (docs/adr/0006), as an unsigned
//! PSBT for the normal review.
//!
//! - Inputs: the account's own coins, largest first, each with the whole transaction holding it.
//!   A coin of value 0 is never spent: Flush binds tokens to value-0 outputs, and spending one
//!   without its `BAST` marker makes the transaction invalid (`bad-ba-tokens-lost`). So a Send
//!   that spends only coins with value can't touch a token, with no lookup per coin.
//! - Outputs: the payments in order, then change (with its derivation, so the Decoder shows it as
//!   yours) unless it would be dust, which goes to the fee.
//! - Version 2, `nLockTime` 0, every `nSequence` replaceable: no replay marker (docs/adr/0011).
//!
//! Every value and script is read from the transactions it is handed, never from what the server
//! said about them.
use std::str::FromStr;

use bitcoin::absolute::LockTime;
use bitcoin::consensus::encode::{deserialize_hex, serialize};
use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::transaction::Version;
use bitcoin::{Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness};
use serde::{Deserialize, Serialize};

use crate::psbt::{refuse, Refusal, RefusalCode};
use crate::{script_of, AccountKeys};

/// Every input's `nSequence`: replaceable, as Bitcoin Core's wallet sets it.
const SEQUENCE: Sequence = Sequence::ENABLE_RBF_NO_LOCKTIME;

/// Flush Core's `DUST_RELAY_TX_FEE`, sats per 1000 vbytes (`src/policy/policy.h`, as Bitcoin's).
/// Node relay policy, so not a Chain Entry value.
const DUST_RELAY_FEE: u64 = 3000;

/// Flush Core's `DEFAULT_MIN_RELAY_TX_FEE`, sats per 1000 vbytes: below it, nothing is relayed.
const MIN_RELAY_FEE: u64 = 100;

/// What to send, and what to build it from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferOrder {
    /// The account's coins to choose from (the wallet's rule: confirmed or trusted, none held back).
    pub coins: Vec<Coin>,
    pub outputs: Vec<Payment>,
    /// Sats per 1000 vbytes.
    pub fee_rate: u64,
    /// The change address's index (the account's first unused one).
    pub change_index: u32,
}

/// One of the account's outputs: the transaction holding it, and which address it pays.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coin {
    /// The whole transaction, hex.
    pub tx: String,
    pub vout: u32,
    /// 0 receive, 1 change.
    pub chain: u32,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payment {
    /// Always "": a Send moves ECX, the native coin.
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
    pub to: PaymentTo,
}

/// Where a payment goes. Only addresses for now; scripts and data can join without breaking the order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum PaymentTo {
    /// In Flush's encoding.
    Address(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    /// Base64: a PSBT, under the name the wallet's `buildTransfer` gives every chain's payload.
    pub pset: String,
    /// The coins it spends: what the wallet holds back from later transfers until this one confirms.
    pub spent: Vec<Spent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spent {
    /// Display hex.
    pub txid: String,
    pub vout: u32,
}

fn malformed(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::Malformed, message)
}

fn starter_refusal(message: String) -> Refusal {
    refuse(RefusalCode::InvalidStarter, message)
}

/// `sats` as the user reads it.
fn ecx(sats: u64) -> String {
    format!("{}.{:08} ECX", sats / 100_000_000, sats % 100_000_000)
}

/// Flush Core's `GetDustThreshold` at its `DUST_RELAY_TX_FEE`: what it costs to spend `txout`,
/// rounded up. Below it, an output isn't relayed.
pub(crate) fn dust_threshold(txout: &TxOut) -> u64 {
    if txout.script_pubkey.is_op_return() {
        return 0;
    }
    let spend = if txout.script_pubkey.is_witness_program() { 32 + 4 + 1 + 107 / 4 + 4 } else { 32 + 4 + 1 + 107 + 4 };
    ((serialize(txout).len() + spend) as u64 * DUST_RELAY_FEE).div_ceil(1000)
}

/// One of the account's coins, read from its transaction.
struct Spendable {
    outpoint: OutPoint,
    tx: Transaction,
    txout: TxOut,
    chain: u32,
    index: u32,
}

pub fn build_transfer(order_json: &str, starter: &str) -> Result<Built, Refusal> {
    let order: TransferOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid transfer order: {e}")))?;
    let keys = AccountKeys::new(starter).map_err(starter_refusal)?;
    if order.outputs.is_empty() {
        return Err(malformed("A transfer needs at least one output."));
    }
    if order.fee_rate < MIN_RELAY_FEE {
        return Err(malformed(format!("A fee rate of {} sat/kvB is below what Flush relays ({MIN_RELAY_FEE}).", order.fee_rate)));
    }

    let mut payments = vec![];
    let mut need = 0u64;
    for (i, payment) in order.outputs.iter().enumerate() {
        if !payment.asset.is_empty() {
            return Err(malformed(format!("Output {i}: a Send on Flush moves only ECX, not asset {}.", payment.asset)));
        }
        let amount = u64::from_str(&payment.amount)
            .ok()
            .filter(|a| *a > 0)
            .ok_or_else(|| malformed(format!("Output {i}'s amount must be a whole number of sats above 0.")))?;
        let PaymentTo::Address(address) = &payment.to;
        let script = script_of(address.trim()).ok_or_else(|| malformed(format!("Output {i}: {address} isn't a Flush address.")))?;
        let txout = TxOut { value: Amount::from_sat(amount), script_pubkey: script };
        let dust = dust_threshold(&txout);
        if amount < dust {
            return Err(refuse(RefusalCode::Dust, format!("{} is below the smallest amount Flush relays to {address} ({}).", ecx(amount), ecx(dust))));
        }
        need = need.checked_add(amount).ok_or_else(|| malformed("The amounts are too large."))?;
        payments.push(txout);
    }

    let mut coins: Vec<Spendable> = vec![];
    for (i, coin) in order.coins.iter().enumerate() {
        let tx = deserialize_hex::<Transaction>(&coin.tx).map_err(|e| malformed(format!("Coin {i}'s transaction isn't one: {e}")))?;
        let txout = tx.output.get(coin.vout as usize).cloned().ok_or_else(|| malformed(format!("Coin {i}'s transaction has no output {}.", coin.vout)))?;
        let ours = (coin.chain <= 1).then(|| keys.script(coin.chain, coin.index).ok()).flatten();
        if ours.as_ref() != Some(&txout.script_pubkey) {
            return Err(malformed(format!("Coin {i} doesn't pay this account's address {}/{}.", coin.chain, coin.index)));
        }
        let outpoint = OutPoint { txid: tx.compute_txid(), vout: coin.vout };
        if coins.iter().any(|c| c.outpoint == outpoint) {
            return Err(malformed(format!("Coin {i} is listed twice.")));
        }
        if txout.value == Amount::ZERO {
            // A token's output, or a block's empty fee output. Largest first never reaches one
            // while a coin with value is left; skipped here so no other order of selection can.
            continue;
        }
        coins.push(Spendable { outpoint, tx, txout, chain: coin.chain, index: coin.index });
    }
    coins.sort_by(|a, b| b.txout.value.cmp(&a.txout.value).then(a.outpoint.cmp(&b.outpoint)));

    let change_script = keys.script(1, order.change_index).map_err(starter_refusal)?;
    let change_output = |value: u64| TxOut { value: Amount::from_sat(value), script_pubkey: change_script.clone() };
    let change_dust = dust_threshold(&change_output(0));
    let unsigned = |chosen: &[Spendable], change: Option<u64>| {
        let input = chosen.iter().map(|coin| TxIn { previous_output: coin.outpoint, script_sig: ScriptBuf::new(), sequence: SEQUENCE, witness: Witness::new() }).collect();
        let mut output = payments.clone();
        output.extend(change.map(change_output));
        Transaction { version: Version::TWO, lock_time: LockTime::ZERO, input, output }
    };
    // The fee for `tx` once signed: every input gets a witness of the largest size it can have.
    let fee = |tx: &Transaction| {
        let mut signed = tx.clone();
        for input in &mut signed.input {
            input.witness = Witness::from_slice(&[vec![0u8; 72], vec![0u8; 33]]);
        }
        (signed.weight().to_wu().div_ceil(4) * order.fee_rate).div_ceil(1000)
    };

    let mut total = 0u64;
    for count in 1..=coins.len() {
        total += coins[count - 1].txout.value.to_sat();
        let chosen = &coins[..count];
        let with_change = fee(&unsigned(chosen, Some(0)));
        if let Some(change) = total.checked_sub(need + with_change).filter(|change| *change >= change_dust) {
            return psbt(unsigned(chosen, Some(change)), chosen, Some(order.change_index), &keys);
        }
        if total >= need + fee(&unsigned(chosen, None)) {
            // Change too small to relay goes to the fee.
            return psbt(unsigned(chosen, None), chosen, None, &keys);
        }
    }
    let needed = need + fee(&unsigned(&coins, None));
    Err(refuse(
        RefusalCode::InsufficientFunds,
        format!("Not enough ECX: this needs {} with its fee, and the wallet can spend {}.", ecx(needed), ecx(total)),
    ))
}

fn psbt(tx: Transaction, chosen: &[Spendable], change_index: Option<u32>, keys: &AccountKeys) -> Result<Built, Refusal> {
    let payments = tx.output.len() - usize::from(change_index.is_some());
    let mut psbt = Psbt::from_unsigned_tx(tx).map_err(|e| malformed(format!("Can't build the PSBT: {e}")))?;
    for (input, coin) in psbt.inputs.iter_mut().zip(chosen) {
        let pubkey = keys.public_key(coin.chain, coin.index).map_err(starter_refusal)?;
        *input = Input {
            non_witness_utxo: Some(coin.tx.clone()),
            witness_utxo: Some(coin.txout.clone()),
            bip32_derivation: [(pubkey, keys.key_source(coin.chain, coin.index))].into(),
            ..Input::default()
        };
    }
    if let Some(index) = change_index {
        let pubkey = keys.public_key(1, index).map_err(starter_refusal)?;
        psbt.outputs[payments] = Output { bip32_derivation: [(pubkey, keys.key_source(1, index))].into(), ..Output::default() };
    }
    let spent = chosen.iter().map(|coin| Spent { txid: coin.outpoint.txid.to_string(), vout: coin.outpoint.vout }).collect();
    Ok(Built { pset: psbt.to_string(), spent })
}
