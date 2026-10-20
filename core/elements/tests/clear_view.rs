//! Seam 2: `decode(payload, starter)` returns a Clear View exactly when the Elements Decoder fully
//! understands a request inside its binding (spec stories 32-35, "Chain Module interface").
mod common;

use common::*;
use elements_miniscript::elements::pset::Output;
use elements_miniscript::elements::Script;
use ecx_elements::{decode, network, ClearView, DangerousMode, Decoded, Destination};

fn clear(pset: &Pset) -> ClearView {
    match decode(&b64(pset), STARTER).unwrap() {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

fn blind_reason(pset: &Pset) -> String {
    match decode(&b64(pset), STARTER).unwrap() {
        Decoded::Blind { reason, .. } => reason,
        clear => panic!("expected Blind, got {clear:?}"),
    }
}

#[test]
fn a_plain_explicit_transfer_is_a_clear_view_with_each_output_its_destination_and_the_fee() {
    let view = clear(&transfer());
    let asset = network().policy_asset.clone();

    assert!(view.dangerous_modes.is_empty(), "{:?}", view.dangerous_modes);
    assert_eq!(view.outputs.len(), 2, "the fee is its own row: {:?}", view.outputs);
    let (pay, change) = (&view.outputs[0], &view.outputs[1]);
    assert_eq!((pay.index, pay.asset.as_str(), pay.amount.as_str()), (0, asset.as_str(), "120000"));
    assert_eq!(pay.destination, Destination::Address { address: address(FOREIGN, 0, 1), yours: false });
    assert_eq!((change.index, change.amount.as_str()), (1, "29000"));
    assert_eq!(change.destination, Destination::Address { address: address(STARTER, 1, 0), yours: true });
    assert!(address(STARTER, 1, 0).starts_with("elements1"), "the chain's own encoding");
    assert_eq!((view.fee.asset.as_str(), view.fee.amount.as_str()), (asset.as_str(), "1000"));
    // Inputs: ours (signed) and someone else's.
    assert_eq!(view.inputs.iter().map(|i| (i.index, i.amount.as_str(), i.yours)).collect::<Vec<_>>(), vec![(0, "100000", true), (1, "50000", false)]);
}

#[test]
fn an_output_is_yours_only_if_it_re_derives_not_because_it_claims_our_key() {
    let mut pset = transfer();
    // The foreign payment claims our change key's derivation, but its script is someone else's.
    let ours = key(STARTER, 1, 0);
    pset.outputs_mut()[0].bip32_derivation.insert(ours.pk, (ours.fingerprint, ours.path.clone()));
    let view = clear(&pset);
    assert_eq!(view.outputs[0].destination, Destination::Address { address: address(FOREIGN, 0, 1), yours: false });
}

#[test]
fn a_non_default_sighash_is_a_dangerous_mode() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x83)); // SINGLE|ANYONECANPAY
    assert_eq!(clear(&pset).dangerous_modes, vec![DangerousMode::NonDefaultSighash { input: 0, sighash: 0x83 }]);
}

#[test]
fn an_explicit_sighash_all_is_not_dangerous() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x01));
    assert!(clear(&pset).dangerous_modes.is_empty());
}

#[test]
fn a_sighash_type_the_decoder_does_not_know_is_blind() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = transfer();
    for unknown in [0x1f, 0x41] {
        pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(unknown));
        assert!(blind_reason(&pset).contains("sighash"));
    }
}

#[test]
fn a_peg_out_burn_is_a_dangerous_mode_and_its_row_names_the_l1_destination_payout_and_parent_fee() {
    let view = clear(&with_peg_out());
    assert_eq!(view.dangerous_modes, vec![DangerousMode::PegOutBurn { output: 3 }]);
    let burn = view.outputs.iter().find(|o| o.index == 3).expect("the burn is a row");
    assert_eq!(burn.amount, "5000");
    assert_eq!(
        burn.destination,
        Destination::PegOut {
            l1_script_pubkey: format!("0014{}", "11".repeat(20)),
            payout: "4000".into(),
            parent_fee: "1000".into(),
        }
    );
}

#[test]
fn dangerous_modes_combine() {
    use elements_miniscript::elements::pset::PsbtSighashType;
    let mut pset = with_peg_out();
    pset.inputs_mut()[0].sighash_type = Some(PsbtSighashType::from_u32(0x82));
    assert_eq!(
        clear(&pset).dangerous_modes,
        vec![DangerousMode::NonDefaultSighash { input: 0, sighash: 0x82 }, DangerousMode::PegOutBurn { output: 3 }]
    );
}

#[test]
fn a_peg_out_burn_the_decoder_can_only_partly_parse_is_blind() {
    use elements_miniscript::elements::script::Builder;
    let burn = peg_out_burn_script();
    let trailing = Builder::from(burn.to_bytes()).push_slice(&[1, 2, 3]).into_script();
    let cases = [
        ("an extra push", pay(trailing, 5_000)),
        ("a parent fee as large as the burn", pay(burn.clone(), 1_000)),
        ("a burn of another asset", Output::new_explicit(burn, 5_000, other_asset(), None)),
    ];
    for (what, output) in cases {
        let mut pset = transfer();
        pset.add_output(output);
        assert!(blind_reason(&pset).contains("peg-out"), "{what}");
    }
}

#[test]
fn an_op_return_that_is_not_a_peg_out_is_blind() {
    use elements_miniscript::elements::opcodes::all::OP_RETURN;
    use elements_miniscript::elements::script::Builder;
    let mut pset = transfer();
    pset.add_output(pay(Builder::new().push_opcode(OP_RETURN).push_slice(b"hello").into_script(), 0));
    blind_reason(&pset);
}

/// Some asset that isn't the policy asset.
fn other_asset() -> elements_miniscript::elements::AssetId {
    elements_miniscript::elements::AssetId::from_slice(&[7; 32]).unwrap()
}

#[test]
fn a_known_field_the_decoder_does_not_explain_makes_the_request_blind_not_a_partial_clear_view() {
    use elements_miniscript::elements::locktime::Height;
    let cases: Vec<(&str, fn(&mut Pset))> = vec![
        ("an issuance", |p| p.inputs_mut()[0].issuance_value_amount = Some(1)),
        ("a peg-in", |p| p.inputs_mut()[1].pegin_value = Some(1)),
        ("a final scriptSig", |p| p.inputs_mut()[1].final_script_sig = Some(Script::from(vec![0x51]))),
        ("a required height locktime", |p| p.inputs_mut()[1].required_height_locktime = Some(Height::from_consensus(5).unwrap())),
        ("a taproot internal key", |p| {
            p.inputs_mut()[1].tap_internal_key = Some(key(FOREIGN, 0, 5).pk.inner.x_only_public_key().0)
        }),
        ("an output witness script", |p| p.outputs_mut()[0].witness_script = Some(Script::from(vec![0x51]))),
        ("a modifiable transaction", |p| p.global.tx_data.tx_modifiable = Some(1)),
    ];
    for (what, mutate) in cases {
        let mut pset = transfer();
        mutate(&mut pset);
        let reason = blind_reason(&pset);
        assert!(reason.contains("doesn't explain"), "{what}: {reason}");
    }
}

#[test]
fn signatures_others_already_added_do_not_stop_a_clear_view() {
    let mut pset = transfer();
    let theirs = key(FOREIGN, 0, 0);
    pset.inputs_mut()[1].partial_sigs.insert(theirs.pk, vec![0x30; 71]);
    clear(&pset);
}

#[test]
fn the_decoder_is_never_applied_outside_its_binding() {
    use ecx_elements::RefusalCode;
    // Another chain's PSET (Liquid mainnet's genesis), otherwise a plain transfer.
    let mut other_chain = transfer();
    set_genesis(&mut other_chain, "1466275836220db2944ca059a3a10ef6fd2ea684b0688d2c379296888a206003");
    assert_eq!(decode(&b64(&other_chain), STARTER).unwrap_err().code, RefusalCode::WrongGenesis);
    // Another format: a Bitcoin PSBT ("psbt\xff" magic).
    assert_eq!(decode("cHNidP8BAAoCAAAAAAAAAAAAAA==", STARTER).unwrap_err().code, RefusalCode::Malformed);
}

#[test]
fn unknown_fields_make_an_otherwise_clear_transfer_blind() {
    assert!(blind_reason(&transfer_with_unknown_fields()).contains("doesn't understand"));
}
