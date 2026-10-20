//! Seam 2: `decode(payload, starter)` through the Chain Module's public interface: the request's
//! refusals (spec "Signing Request" rules 5-7) and, short of a Clear View, Blind with the facts the
//! module can still prove.
mod common;

use common::*;
use ecx_elements::{decode, sign, Decoded, RefusalCode};

fn refusal(pset: &Pset) -> RefusalCode {
    decode(&b64(pset), STARTER).expect_err("refused").code
}

#[test]
fn a_payload_that_is_not_a_pset_is_refused_as_malformed() {
    assert_eq!(decode("bm90IGEgcHNldA==", STARTER).unwrap_err().code, RefusalCode::Malformed);
}

#[test]
fn a_pset_for_another_chain_is_refused() {
    let mut pset = transfer();
    // Liquid mainnet's genesis.
    set_genesis(&mut pset, "1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003");
    assert_eq!(refusal(&pset), RefusalCode::WrongGenesis);
}

#[test]
fn a_pset_without_the_elip_101_genesis_is_refused() {
    let mut pset = transfer();
    pset.global.proprietary.clear();
    assert_eq!(refusal(&pset), RefusalCode::WrongGenesis);
}

#[test]
fn a_confidential_input_is_refused() {
    assert_eq!(refusal(&with_confidential_input()), RefusalCode::Confidential);
}

#[test]
fn a_confidential_output_is_refused() {
    assert_eq!(refusal(&with_confidential_output()), RefusalCode::Confidential);
}

#[test]
fn an_input_without_witness_utxo_is_refused() {
    let mut pset = transfer();
    pset.inputs_mut()[1].witness_utxo = None;
    assert_eq!(refusal(&pset), RefusalCode::MissingInputFields);
}

#[test]
fn an_input_without_bip32_derivation_is_refused() {
    assert_eq!(refusal(&with_missing_derivation()), RefusalCode::MissingInputFields);
}

#[test]
fn sign_refuses_exactly_what_decode_refuses() {
    for pset in [with_confidential_input(), with_missing_derivation()] {
        assert_eq!(sign(&b64(&pset), STARTER).unwrap_err().code, refusal(&pset));
    }
}

#[test]
fn an_unknown_field_makes_the_request_blind_with_the_facts_the_wallet_can_prove() {
    let Decoded::Blind { reason, verifiable_facts: facts } = decode(&b64(&transfer_with_unknown_fields()), STARTER).unwrap() else {
        panic!("expected Blind")
    };
    assert!(reason.contains("doesn't understand"), "{reason}");

    let asset = network_policy_asset();
    // Input 0 is ours (100 000); input 1 is someone else's.
    assert_eq!(facts.owned_inputs.len(), 1);
    assert_eq!((facts.owned_inputs[0].index, facts.owned_inputs[0].amount.as_str()), (0, "100000"));
    // 100 000 in, 29 000 change back to us: 71 000 leaves the wallet, 1 000 of it as fee.
    assert_eq!(facts.total_leaving.len(), 1);
    assert_eq!((facts.total_leaving[0].asset.as_str(), facts.total_leaving[0].amount.as_str()), (asset.as_str(), "71000"));
    assert_eq!(facts.fee.len(), 1);
    assert_eq!((facts.fee[0].asset.as_str(), facts.fee[0].amount.as_str()), (asset.as_str(), "1000"));
    assert_eq!(facts.unknown_fields.len(), 4, "{:?}", facts.unknown_fields);
    assert!(facts.dangerous_flags.is_empty(), "{:?}", facts.dangerous_flags);
}

#[test]
fn in_a_blind_request_a_non_default_sighash_and_a_withdrawal_burn_are_dangerous_flags() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer_with_unknown_fields();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x83));
    pset.add_output(pay(withdrawal_burn_script(), 5_000));
    let Decoded::Blind { verifiable_facts: facts, .. } = decode(&b64(&pset), STARTER).unwrap() else { panic!("expected Blind") };
    let flags = facts.dangerous_flags.join("\n");
    assert!(flags.contains("sighash"), "{flags}");
    assert!(flags.contains("withdrawal"), "{flags}");
}

#[test]
fn an_input_claiming_our_key_without_proof_is_a_dangerous_flag_and_not_counted_as_ours() {
    let mut pset = transfer();
    let ours = key(STARTER, 0, 0);
    pset.inputs_mut()[1].bip32_derivation.insert(ours.pk, (ours.fingerprint, ours.path.clone()));
    let Decoded::Blind { verifiable_facts: facts, .. } = decode(&b64(&pset), STARTER).unwrap() else { panic!("expected Blind") };
    assert_eq!(facts.owned_inputs.iter().map(|i| i.index).collect::<Vec<_>>(), vec![0]);
    assert!(facts.dangerous_flags.join("\n").contains("input 1"), "{:?}", facts.dangerous_flags);
}

fn network_policy_asset() -> String {
    ecx_elements::network().policy_asset.clone()
}
