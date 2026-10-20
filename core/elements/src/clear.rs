//! The Elements Decoder: a Clear View of a request it fully understands, or the reason it can't
//! give one (the request is then Blind; never a partial Clear View).
//!
//! Hand-written: LWK's `pset_balance` refuses owned explicit inputs and outputs. Whether an input or
//! output is "yours" is decided only by re-deriving it (`ownership.rs`), never by the requester.
use elements_miniscript::elements::confidential::{Asset, Value};
use std::str::FromStr;

use elements_miniscript::elements::pset::{Input, Output, PartiallySignedTransaction, PsbtSighashType};
use elements_miniscript::elements::script::Instruction;
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::{Address, AssetId, Txid};
use serde::Serialize;

use crate::account::address_params;
use crate::decode::{is_peg_out_burn, AssetAmount};
use crate::network;
use crate::ownership::Wallet;

/// What the user is shown for a request the Decoder fully understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearView {
    /// Risky modes, to be shown above everything else.
    pub dangerous_modes: Vec<DangerousMode>,
    pub inputs: Vec<ClearInput>,
    /// Every output except the fee.
    pub outputs: Vec<ClearOutput>,
    pub fee: AssetAmount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearInput {
    pub index: usize,
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
    /// Re-derives to this Starter's keys: `sign` signs it.
    pub yours: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutput {
    pub index: usize,
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
    pub destination: Destination,
}

/// Where an output's funds go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Destination {
    /// An address on this chain, in its own encoding; `yours` only if it re-derives to the Starter.
    Address { address: String, yours: bool },
    /// A peg-out burn (native withdrawal): the amount is destroyed here, and `payout` (the burn
    /// minus `parent_fee`) may be paid on L1 to `l1_script_pubkey` once the withdrawal is accepted.
    #[serde(rename_all = "camelCase")]
    PegOut {
        /// Hex.
        l1_script_pubkey: String,
        /// Base units, as a decimal string.
        payout: String,
        /// Base units, as a decimal string.
        parent_fee: String,
    },
}

/// A risky mode of the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DangerousMode {
    /// The input's signature commits to less than the whole transaction (anything but ALL), so
    /// others could change what it signs.
    NonDefaultSighash { input: usize, sighash: u32 },
    /// The output burns funds to withdraw them to L1: irreversible, and paid (if ever) only after
    /// the multi-month BIP300 withdrawal vote.
    PegOutBurn { output: usize },
}

/// The Clear View of `pset` (already through rules 5-7), or why the Decoder can't give one.
pub(crate) fn clear_view(pset: &PartiallySignedTransaction, wallet: &Wallet) -> Result<ClearView, String> {
    let explicit = |asset: Asset, value: Value| match (asset, value) {
        (Asset::Explicit(a), Value::Explicit(v)) => (a.to_string(), v.to_string()),
        _ => unreachable!("validated: explicit only"),
    };
    let global = &pset.global;
    if !global.xpub.is_empty() || global.tx_data.tx_modifiable.is_some() || global.elements_tx_modifiable_flag.is_some() {
        return Err("it has global fields the Decoder doesn't explain.".into());
    }
    if let Some(i) = pset.inputs().iter().position(|input| !only_explained_input_fields(input)) {
        return Err(format!("input {i} has fields the Decoder doesn't explain."));
    }
    if let Some(i) = pset.outputs().iter().position(|output| !only_explained_output_fields(output)) {
        return Err(format!("output {i} has fields the Decoder doesn't explain."));
    }

    let mut dangerous_modes = vec![];
    let mut inputs = vec![];
    for (index, input) in pset.inputs().iter().enumerate() {
        let utxo = input.witness_utxo.as_ref().expect("validated");
        let (asset, amount) = explicit(utxo.asset, utxo.value);
        let yours = wallet.owned_input_key(input).is_some();
        if !yours && wallet.claims_our_key(input) {
            return Err(format!("input {index} claims one of this wallet's keys, but it doesn't re-derive."));
        }
        match input.sighash_type.map(|t| t.to_u32()) {
            None | Some(SIGHASH_ALL) => {}
            Some(sighash) if is_known_sighash(sighash) => {
                dangerous_modes.push(DangerousMode::NonDefaultSighash { input: index, sighash })
            }
            Some(sighash) => return Err(format!("input {index} asks for unknown sighash type 0x{sighash:02x}.")),
        }
        inputs.push(ClearInput { index, asset, amount, yours });
    }

    let mut outputs = vec![];
    let mut fee = None;
    for (index, output) in pset.outputs().iter().enumerate() {
        let (asset, amount) = (output.asset.expect("validated").to_string(), output.amount.expect("validated").to_string());
        if output.script_pubkey.is_empty() {
            fee = Some(AssetAmount { asset, amount });
            continue;
        }
        let destination = if is_peg_out_burn(&output.script_pubkey) {
            let peg_out = peg_out(output).ok_or_else(|| format!("output {index} is a peg-out burn it can't fully parse."))?;
            dangerous_modes.push(DangerousMode::PegOutBurn { output: index });
            peg_out
        } else {
            let address = Address::from_script(&output.script_pubkey, None, address_params())
                .ok_or_else(|| format!("output {index} pays a script that isn't an address."))?;
            Destination::Address { address: address.to_string(), yours: wallet.owns_output(output) }
        };
        outputs.push(ClearOutput { index, asset, amount, destination });
    }
    let fee = fee.ok_or("The request has no fee output.")?;
    Ok(ClearView { dangerous_modes, inputs, outputs, fee })
}

/// True if `input` sets nothing beyond what a Clear View shows or `sign` needs. Unknown and
/// proprietary fields are reported (and make the request Blind) before this.
fn only_explained_input_fields(input: &Input) -> bool {
    let rest = Input {
        previous_txid: Txid::all_zeros(),
        previous_output_index: 0,
        sequence: None,
        witness_utxo: None,
        bip32_derivation: Default::default(),
        sighash_type: None,
        partial_sigs: Default::default(),
        proprietary: Default::default(),
        unknown: Default::default(),
        ..input.clone()
    };
    rest == Input::default()
}

/// True if `output` sets nothing beyond its explicit asset, amount, script and derivation.
fn only_explained_output_fields(output: &Output) -> bool {
    let rest = Output {
        amount: None,
        asset: None,
        script_pubkey: Default::default(),
        bip32_derivation: Default::default(),
        proprietary: Default::default(),
        unknown: Default::default(),
        ..output.clone()
    };
    rest == Output::default()
}

/// Strictly parses a native-withdrawal burn as this fork's consensus does
/// (`ParseNativeWithdrawalOutput`): `OP_RETURN <parent genesis> <L1 script> <parent fee, BE u64>`,
/// exactly three minimal pushes, the L1 script at most 128 bytes, an explicit pegged-asset amount
/// larger than the parent fee.
fn peg_out(output: &Output) -> Option<Destination> {
    if output.asset? != AssetId::from_str(&network().policy_asset).expect("Chain Entry policy asset is valid") {
        return None;
    }
    let pushes: Vec<&[u8]> = output
        .script_pubkey
        .instructions_minimal()
        .skip(1) // OP_RETURN
        .map(|i| match i {
            Ok(Instruction::PushBytes(bytes)) => Some(bytes),
            _ => None,
        })
        .collect::<Option<_>>()?;
    let [_genesis, l1_script, fee] = pushes[..] else { return None };
    if l1_script.is_empty() || l1_script.len() > 128 {
        return None;
    }
    let parent_fee = u64::from_be_bytes(fee.try_into().ok()?);
    let payout = output.amount?.checked_sub(parent_fee).filter(|p| *p > 0)?;
    Some(Destination::PegOut { l1_script_pubkey: hex(l1_script), payout: payout.to_string(), parent_fee: parent_fee.to_string() })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const SIGHASH_ALL: u32 = 0x01;

/// The standard ECDSA sighash types (ALL/NONE/SINGLE, each optionally ANYONECANPAY): the ones
/// rust-elements signs as asked. LWK would sign any other type (RANGEPROOF included) as ALL, so
/// the Decoder can't explain it.
fn is_known_sighash(sighash: u32) -> bool {
    PsbtSighashType::from_u32(sighash).ecdsa_hash_ty().is_some()
}
