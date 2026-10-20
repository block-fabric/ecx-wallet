//! One pass over a validated PSET that both the Decoder (`clear.rs`) and the verifiable facts
//! (`decode.rs`) read, so they can never disagree on which inputs are yours, which sighash each
//! input asks for, what the fee is, or which outputs are withdrawal burns.
use std::collections::BTreeMap;
use std::str::FromStr;

use elements_miniscript::elements::confidential::{Asset, Value};
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::pset::{PartiallySignedTransaction, PsbtSighashType};
use elements_miniscript::elements::script::Instruction;
use elements_miniscript::elements::{BlockHash, Script};

use crate::network;
use crate::ownership::Wallet;

pub(crate) struct Classified {
    pub(crate) inputs: Vec<InputClass>,
    pub(crate) outputs: Vec<OutputClass>,
    /// Per asset (display hex), the sum of every fee output.
    pub(crate) fee: BTreeMap<String, u128>,
}

pub(crate) struct InputClass {
    pub(crate) index: usize,
    /// Display hex.
    pub(crate) asset: String,
    pub(crate) amount: u64,
    /// Re-derives to this Starter's keys: `sign` signs it.
    pub(crate) yours: bool,
    /// Names this wallet's fingerprint without re-deriving.
    pub(crate) unproven_claim: bool,
    pub(crate) sighash: Sighash,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sighash {
    /// None set, or ALL.
    All,
    /// A standard type other than ALL (NONE/SINGLE, optionally ANYONECANPAY).
    Known(u32),
    /// A type rust-elements wouldn't sign as asked (LWK would sign it as ALL).
    Unknown(u32),
}

pub(crate) struct OutputClass {
    pub(crate) index: usize,
    /// Display hex.
    pub(crate) asset: String,
    pub(crate) amount: u64,
    pub(crate) kind: OutputKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum OutputKind {
    /// Empty script.
    Fee,
    /// An OP_RETURN naming the parent chain's genesis: how a Withdrawal starts.
    WithdrawalBurn,
    /// Any other script; `yours` only if it re-derives to this Starter.
    Script { yours: bool },
}

const SIGHASH_ALL: u32 = 0x01;

/// Classifies `pset` (already through rules 5-7: explicit-only, every input with `witness_utxo`).
pub(crate) fn classify(pset: &PartiallySignedTransaction, wallet: &Wallet) -> Classified {
    let inputs = pset
        .inputs()
        .iter()
        .enumerate()
        .map(|(index, input)| {
            let utxo = input.witness_utxo.as_ref().expect("validated");
            let (Asset::Explicit(asset), Value::Explicit(amount)) = (utxo.asset, utxo.value) else { unreachable!("validated") };
            let yours = wallet.owned_input_key(input).is_some();
            let sighash = match input.sighash_type.map(|t| t.to_u32()) {
                None | Some(SIGHASH_ALL) => Sighash::All,
                Some(s) if PsbtSighashType::from_u32(s).ecdsa_hash_ty().is_some() => Sighash::Known(s),
                Some(s) => Sighash::Unknown(s),
            };
            InputClass { index, asset: asset.to_string(), amount, yours, unproven_claim: !yours && wallet.claims_our_key(input), sighash }
        })
        .collect();

    let mut fee = BTreeMap::<String, u128>::new();
    let outputs = pset
        .outputs()
        .iter()
        .enumerate()
        .map(|(index, output)| {
            let (asset, amount) = (output.asset.expect("validated").to_string(), output.amount.expect("validated"));
            let kind = if output.script_pubkey.is_empty() {
                *fee.entry(asset.clone()).or_default() += amount as u128;
                OutputKind::Fee
            } else if is_withdrawal_burn(&output.script_pubkey) {
                OutputKind::WithdrawalBurn
            } else {
                OutputKind::Script { yours: wallet.owns_output(output) }
            };
            OutputClass { index, asset, amount, kind }
        })
        .collect();

    Classified { inputs, outputs, fee }
}

/// An OP_RETURN whose first push is the parent (L1) chain's genesis: a native-withdrawal burn.
fn is_withdrawal_burn(script: &Script) -> bool {
    let parent = BlockHash::from_str(&network().parent_genesis_hash).expect("Chain Entry parent genesis is valid");
    let mut instructions = script.instructions();
    script.is_op_return()
        && instructions.next().is_some()
        && matches!(instructions.next(), Some(Ok(Instruction::PushBytes(bytes))) if bytes == parent.as_byte_array())
}
