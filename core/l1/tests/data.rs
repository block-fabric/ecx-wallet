//! A data transaction (docs/adr/0021), end to end inside the module: one zero-value `OP_RETURN`
//! carrying the bytes a Slot's Chain Module made (a Sidepot entry), funded, decoded, signed and
//! finalized as a Send is, replay-marked like every L1 spend.
mod common;

use std::str::FromStr;

use bitcoin::consensus::encode::deserialize_hex;
use bitcoin::psbt::Psbt;
use bitcoin::{Sequence, Transaction};
use common::{account_key, paying, receive_0, tx_hex};
use ecx_l1::{build_data, decode, derive_account, finalize, network, sign, ClearView, Decoded, Destination, RefusalCode};
use serde_json::json;

/// 1 sat/vB.
const FEE_RATE: u64 = 1000;

fn coin(seed: u8, value: u64) -> serde_json::Value {
    json!({ "tx": tx_hex(&paying(seed, &[(&receive_0(), value)])), "vout": 0, "chain": 0, "index": 0 })
}

fn data(len: usize) -> String {
    (0..len).map(|i| format!("{:02x}", i % 251)).collect()
}

fn order(data: &str, coins: Vec<serde_json::Value>) -> String {
    json!({ "coins": coins, "data": data, "feeRate": FEE_RATE, "changeIndex": 2 }).to_string()
}

fn built(order: &str) -> String {
    build_data(order, &account_key()).unwrap().pset
}

fn clear(psbt: &str) -> ClearView {
    match decode(psbt, &account_key()).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

#[test]
fn it_carries_the_data_in_one_zero_value_op_return_then_change() {
    for len in [128, 142] {
        let built = build_data(&order(&data(len), vec![coin(1, 100_000)]), &account_key()).unwrap();
        let tx = &Psbt::from_str(&built.pset).unwrap().unsigned_tx;
        assert_eq!(tx.output.len(), 2);
        assert_eq!(tx.output[0].value.to_sat(), 0);
        // OP_RETURN OP_PUSHDATA1 <len> <data>: how Sidepot reads an entry.
        assert_eq!(tx.output[0].script_pubkey.to_hex_string(), format!("6a4c{len:02x}{}", data(len)));
        assert_eq!(tx.output[1].script_pubkey.to_hex_string(), derive_account(&account_key(), 0, 3).unwrap().change[2].script_pubkey);
        assert_eq!(built.spent.len(), 1);
        assert_eq!((built.spent[0].txid.clone(), built.spent[0].vout), (tx.input[0].previous_output.txid.to_string(), 0));
    }
}

#[test]
fn a_push_is_minimal_at_every_length_it_takes() {
    let script = |len: usize| Psbt::from_str(&built(&order(&data(len), vec![coin(1, 100_000)]))).unwrap().unsigned_tx.output[0].script_pubkey.to_hex_string();
    assert_eq!(script(1), "6a0100");
    assert_eq!(script(75), format!("6a4b{}", data(75)));
    assert_eq!(script(76), format!("6a4c4c{}", data(76)));
    assert_eq!(script(255), format!("6a4cff{}", data(255)));
}

#[test]
fn the_decoder_shows_it_clear_as_data_with_change_as_yours() {
    let view = clear(&built(&order(&data(128), vec![coin(1, 100_000)])));
    assert!(view.dangerous_modes.is_empty());
    assert_eq!(view.outputs.len(), 2);
    assert_eq!((view.outputs[0].amount.as_str(), &view.outputs[0].destination), ("0", &Destination::Data { data: data(128) }));
    let change = derive_account(&account_key(), 0, 3).unwrap().change[2].address.clone();
    assert_eq!(view.outputs[1].destination, Destination::Address { address: change, yours: true });
    assert!(view.inputs.iter().all(|i| i.yours));
    let fee: u64 = view.fee.amount.parse().unwrap();
    assert_eq!(100_000 - view.outputs[1].amount.parse::<u64>().unwrap(), fee, "it pays its fee and nothing else");
}

#[test]
fn it_is_replay_marked_and_replaceable() {
    let psbt = Psbt::from_str(&built(&order(&data(142), vec![coin(1, 100_000)]))).unwrap();
    assert_eq!(psbt.unsigned_tx.lock_time.to_consensus_u32(), network().params.replay_lock_time);
    assert!(psbt.unsigned_tx.input.iter().all(|i| i.sequence == Sequence::ENABLE_RBF_NO_LOCKTIME));
}

#[test]
fn signed_and_finalized_it_is_a_complete_transaction_that_pays_its_rate() {
    let psbt = built(&order(&data(128), vec![coin(1, 100_000)]));
    let fee: u64 = clear(&psbt).fee.amount.parse().unwrap();
    let finalized = finalize(&sign(&psbt, &account_key()).unwrap()).unwrap();
    let tx: Transaction = deserialize_hex(&finalized.tx).unwrap();
    assert_eq!(tx.compute_txid().to_string(), finalized.txid);
    assert!(tx.input.iter().all(|i| i.witness.len() == 2));
    assert!(fee >= tx.vsize() as u64 * FEE_RATE / 1000, "fee {fee} for {} vB", tx.vsize());
}

#[test]
fn coins_are_chosen_as_a_sends_and_change_below_dust_goes_to_the_fee() {
    let psbt = Psbt::from_str(&built(&order(&data(128), vec![coin(1, 20_000), coin(2, 90_000), coin(3, 40_000)]))).unwrap();
    assert_eq!(psbt.inputs.len(), 1);
    assert_eq!(psbt.inputs[0].witness_utxo.as_ref().unwrap().value.to_sat(), 90_000);

    let view = clear(&built(&order(&data(128), vec![coin(1, 500)])));
    assert_eq!(view.outputs.len(), 1, "no change output");
    assert_eq!(view.fee.amount, "500");
}

#[test]
fn data_of_no_bytes_too_many_or_not_hex_is_refused() {
    for bad in [String::new(), data(256), "zz".to_string(), "abc".to_string()] {
        let error = build_data(&order(&bad, vec![coin(1, 100_000)]), &account_key()).unwrap_err();
        assert_eq!(error.code, RefusalCode::Malformed, "{bad}");
        assert!(error.message.contains("1 to 255 bytes of hex"), "{}", error.message);
    }
}

#[test]
fn not_enough_coins_for_the_fee_is_a_refusal() {
    let error = build_data(&order(&data(128), vec![coin(1, 100)]), &account_key()).unwrap_err();
    assert_eq!(error.code, RefusalCode::InsufficientFunds);
}
