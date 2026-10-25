//! The wallet's Send of ECX inside the module: built from the account's coins, decoded by the Flush
//! Decoder, signed and finalized. No replay marker, and never a value-0 coin.
mod common;

use std::str::FromStr;

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::psbt::Psbt;
use bitcoin::{Sequence, Transaction};
use common::{address, paying, script, tx_hex, FOREIGN, STARTER};
use ecx_flush::{build_transfer, decode, finalize, sign, ClearView, Decoded, Destination, RefusalCode};
use serde_json::json;

/// 1 sat/vB.
const FEE_RATE: u64 = 1000;

/// The account's coin of `value` sats on `chain`/`index`.
fn coin_at(seed: u8, value: u64, chain: u32, index: u32) -> serde_json::Value {
    json!({ "tx": tx_hex(&paying(seed, &[(&script(STARTER, chain, index), value)])), "vout": 0, "chain": chain, "index": index })
}

fn coin(seed: u8, value: u64) -> serde_json::Value {
    coin_at(seed, value, 0, 0)
}

fn order(amount: u64, coins: Vec<serde_json::Value>) -> String {
    let to = address(FOREIGN, 0, 0);
    json!({ "coins": coins, "outputs": [{ "asset": "", "amount": amount.to_string(), "to": { "address": to } }], "feeRate": FEE_RATE, "changeIndex": 2 })
        .to_string()
}

fn built(order: &str) -> Psbt {
    Psbt::from_str(&build_transfer(order, STARTER).unwrap().pset).unwrap()
}

fn clear(psbt: &Psbt) -> ClearView {
    match decode(&psbt.to_string(), STARTER).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

#[test]
fn a_send_pays_the_address_then_change_with_no_replay_marker() {
    let psbt = built(&order(40_000, vec![coin(1, 100_000)]));
    let tx = &psbt.unsigned_tx;
    assert_eq!(tx.version.0, 2);
    assert_eq!(tx.lock_time.to_consensus_u32(), 0);
    assert!(tx.input.iter().all(|i| i.sequence == Sequence::ENABLE_RBF_NO_LOCKTIME));
    assert_eq!(tx.output[0].script_pubkey, script(FOREIGN, 0, 0));
    assert_eq!(tx.output[0].value.to_sat(), 40_000);
    assert_eq!(tx.output[1].script_pubkey, script(STARTER, 1, 2), "change goes to the change index asked for");
    assert!(psbt.inputs.iter().all(|i| i.non_witness_utxo.is_some() && i.bip32_derivation.len() == 1));

    let view = clear(&psbt);
    let fee: u64 = view.fee.amount.parse().unwrap();
    assert_eq!(40_000 + tx.output[1].value.to_sat() + fee, 100_000);
    assert!((100..=200).contains(&fee), "about 141 vB at 1 sat/vB, got {fee}");
    assert_eq!(view.outputs[0].destination, Destination::Address { address: address(FOREIGN, 0, 0), yours: false });
    assert_eq!(view.outputs[1].destination, Destination::Address { address: address(STARTER, 1, 2), yours: true });
    assert!(view.inputs.iter().all(|i| i.yours && i.asset.is_empty()));
}

#[test]
fn a_send_never_spends_a_value_0_coin() {
    // A token's output and a block's empty fee output both hold 0 ECX.
    let psbt = built(&order(40_000, vec![coin(1, 0), coin(2, 100_000), coin_at(3, 0, 1, 0)]));
    assert_eq!(psbt.unsigned_tx.input.len(), 1);
    assert_eq!(psbt.unsigned_tx.input[0].previous_output.txid, paying(2, &[(&script(STARTER, 0, 0), 100_000)]).compute_txid());

    let refusal = build_transfer(&order(40_000, vec![coin(1, 0), coin(3, 0)]), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InsufficientFunds);
}

#[test]
fn coins_are_spent_largest_first_and_only_as_many_as_needed() {
    let psbt = built(&order(60_000, vec![coin(1, 30_000), coin(2, 50_000), coin(3, 20_000)]));
    let values: Vec<u64> = psbt.inputs.iter().zip(&psbt.unsigned_tx.input).map(|(i, txin)| i.non_witness_utxo.as_ref().unwrap().output[txin.previous_output.vout as usize].value.to_sat()).collect();
    assert_eq!(values, [50_000, 30_000]);
}

#[test]
fn change_too_small_to_relay_goes_to_the_fee() {
    let psbt = built(&order(99_700, vec![coin(1, 100_000)]));
    assert_eq!(psbt.unsigned_tx.output.len(), 1, "300 sats minus the change's own fee is below 294");
    assert_eq!(clear(&psbt).fee.amount, "300");
}

#[test]
fn a_payment_below_flushs_dust_is_refused() {
    let refusal = build_transfer(&order(293, vec![coin(1, 100_000)]), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::Dust);
    assert!(refusal.message.contains("0.00000294 ECX"), "{}", refusal.message);
    assert!(build_transfer(&order(294, vec![coin(1, 100_000)]), STARTER).is_ok());
}

#[test]
fn not_enough_ecx_says_what_it_needs_and_what_the_wallet_has() {
    let refusal = build_transfer(&order(100_000, vec![coin(1, 60_000), coin(2, 40_000)]), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InsufficientFunds);
    assert!(refusal.message.contains("the wallet can spend 0.00100000 ECX"), "{}", refusal.message);
}

#[test]
fn a_send_moves_only_ecx_to_a_flush_address() {
    let with = |asset: &str, to: &str| {
        json!({ "coins": [coin(1, 100_000)], "outputs": [{ "asset": asset, "amount": "1000", "to": { "address": to } }], "feeRate": FEE_RATE, "changeIndex": 0 }).to_string()
    };
    let flush = address(FOREIGN, 0, 0);
    assert_eq!(build_transfer(&with(&"00".repeat(32), &flush), STARTER).unwrap_err().code, RefusalCode::Malformed);
    for other in ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm", "bflx1qnotanaddress"] {
        let refusal = build_transfer(&with("", other), STARTER).unwrap_err();
        assert!(refusal.message.contains("isn't a Flush address"), "{other}: {}", refusal.message);
    }
}

#[test]
fn a_coin_must_pay_the_address_it_names_and_be_listed_once() {
    let foreign = json!({ "tx": tx_hex(&paying(1, &[(&script(FOREIGN, 0, 0), 100_000)])), "vout": 0, "chain": 0, "index": 0 });
    assert!(build_transfer(&order(1000, vec![foreign]), STARTER).unwrap_err().message.contains("doesn't pay this account's address"));
    assert!(build_transfer(&order(1000, vec![coin(1, 100_000), coin(1, 100_000)]), STARTER).unwrap_err().message.contains("listed twice"));
}

#[test]
fn a_fee_rate_below_flushs_relay_minimum_is_refused() {
    let order = order(1000, vec![coin(1, 100_000)]).replace("\"feeRate\":1000", "\"feeRate\":99");
    assert!(build_transfer(&order, STARTER).unwrap_err().message.contains("below what Flush relays"));
}

#[test]
fn a_built_send_signs_and_finalizes_into_a_transaction_with_a_witness_per_input() {
    let psbt = built(&order(60_000, vec![coin(1, 30_000), coin(2, 50_000)]));
    let signed = sign(&psbt.to_string(), STARTER).unwrap();
    let finalized = finalize(&signed).unwrap();
    let tx: Transaction = deserialize_hex(&finalized.tx).unwrap();
    assert_eq!(tx.compute_txid().to_string(), finalized.txid);
    assert_eq!(tx.compute_txid(), psbt.unsigned_tx.compute_txid(), "signing changes only the witnesses");
    assert!(tx.input.iter().all(|i| i.witness.len() == 2));
    assert_eq!(tx.lock_time.to_consensus_u32(), 0);
}
