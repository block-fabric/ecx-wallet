//! `decode(payload, starter)`: the Flush Decoder. A Clear View of a request it fully understands,
//! or `Blind { reason, verifiableFacts }`; never a partial Clear View.
//!
//! It understands payments of ECX to addresses, and nothing else: every Flush operation (tokens,
//! the DEX, staking, withdrawals) is an `OP_RETURN` marker, and a request carrying one is Blind,
//! naming the operation when the tag is known. Whether an input or output is "yours" is decided
//! only by re-deriving it from the Starter, never by the requester; with no `bip32_derivation`,
//! only the receive address apps are given counts (docs/adr/0007). Every amount comes from the
//! previous transactions the PSBT carries, which `validated` checked against their txids.
use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::secp256k1::PublicKey;
use bitcoin::{EcdsaSighashType, TxOut};
use serde::Serialize;

use crate::psbt::{operation, refuse, spent, validated, AssetAmount, OwnedInput, Refusal, RefusalCode};
use crate::{address, AccountKeys};

/// What `decode` makes of a request it doesn't refuse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Decoded {
    /// The module can't show what this request means; only the facts it can prove.
    #[serde(rename_all = "camelCase")]
    Blind { reason: String, verifiable_facts: VerifiableFacts },
    /// The Decoder fully understands the request: here is what it does.
    Clear { view: ClearView },
}

/// What the module proves about a request without understanding it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiableFacts {
    /// Inputs that re-derive to the Starter (the only ones `sign` will sign).
    pub owned_inputs: Vec<OwnedInput>,
    /// Owned inputs minus outputs that re-derive to the Starter. Negative means more comes back.
    pub total_leaving: Vec<AssetAmount>,
    pub fee: Vec<AssetAmount>,
    /// Fields inside the PSBT the module doesn't know (preserved byte-for-byte when signing).
    pub unknown_fields: Vec<String>,
    /// Anything risky, to be shown above everything else.
    pub dangerous_flags: Vec<String>,
}

/// What the user is shown for a request the Decoder fully understands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearView {
    /// Always empty: a plain payment has no risky mode. Kept for the wallet's shared shape.
    pub dangerous_modes: Vec<DangerousMode>,
    pub inputs: Vec<ClearInput>,
    pub outputs: Vec<ClearOutput>,
    pub fee: AssetAmount,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearInput {
    pub index: usize,
    /// Always "".
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
    /// Re-derives to the Starter: `sign` signs it.
    pub yours: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutput {
    pub index: usize,
    /// Always "".
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
    pub destination: Destination,
}

/// Where an output's funds go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Destination {
    /// A Flush address; `yours` only if it re-derives to the Starter.
    Address { address: String, yours: bool },
}

/// A risky mode of a request. The Decoder explains none yet: what has one is Blind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum DangerousMode {}

/// What an input is, decided by re-deriving it.
pub(crate) enum InputKind {
    Yours { chain: u32, index: u32, pubkey: PublicKey },
    /// Names the Starter's fingerprint, but doesn't re-derive: never signed.
    UnprovenClaim,
    Foreign,
}

pub(crate) fn classify_input(keys: &AccountKeys, input: &Input, spent: &TxOut) -> InputKind {
    let script = &spent.script_pubkey;
    let yours = |(chain, index): (u32, u32)| keys.public_key(chain, index).ok().map(|pubkey| InputKind::Yours { chain, index, pubkey });
    if input.bip32_derivation.is_empty() {
        return keys.given_out(script).and_then(yours).unwrap_or(InputKind::Foreign);
    }
    if let Some(owned) = input.bip32_derivation.iter().find_map(|(pubkey, source)| keys.owns(pubkey, source, script)) {
        return yours(owned).unwrap_or(InputKind::Foreign);
    }
    if input.bip32_derivation.values().any(|source| keys.claims(source)) {
        return InputKind::UnprovenClaim;
    }
    InputKind::Foreign
}

pub(crate) fn output_yours(keys: &AccountKeys, output: &Output, txout: &TxOut) -> bool {
    if output.bip32_derivation.is_empty() {
        return keys.given_out(&txout.script_pubkey).is_some();
    }
    output.bip32_derivation.iter().any(|(pubkey, source)| keys.owns(pubkey, source, &txout.script_pubkey).is_some())
}

/// The kind of each input, refusing a request with none of the Starter's (docs/adr/0007).
pub(crate) fn classified(psbt: &Psbt, keys: &AccountKeys) -> Result<Vec<InputKind>, Refusal> {
    let kinds: Vec<_> = (0..psbt.inputs.len()).map(|i| classify_input(keys, &psbt.inputs[i], spent(psbt, i))).collect();
    if !kinds.iter().any(|kind| matches!(kind, InputKind::Yours { .. })) {
        return Err(refuse(RefusalCode::NothingToSign, "No input of this request is this wallet's, so it has nothing to sign."));
    }
    Ok(kinds)
}

pub fn decode(payload: &str, starter: &str) -> Result<Decoded, Refusal> {
    let psbt = validated(payload)?;
    let keys = AccountKeys::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let kinds = classified(&psbt, &keys)?;
    let inputs_total: u64 = (0..psbt.inputs.len()).map(|i| spent(&psbt, i).value.to_sat()).sum();
    let outputs_total: u64 = psbt.unsigned_tx.output.iter().map(|o| o.value.to_sat()).sum();
    let fee = inputs_total
        .checked_sub(outputs_total)
        .ok_or_else(|| refuse(RefusalCode::Malformed, "The outputs add up to more than the inputs."))?;

    let facts = verifiable_facts(&psbt, &keys, &kinds, fee);
    if !facts.unknown_fields.is_empty() {
        let reason = "The request contains fields the Flush Decoder doesn't understand.";
        return Ok(Decoded::Blind { reason: reason.into(), verifiable_facts: facts });
    }
    if let Some((index, op)) = psbt.unsigned_tx.output.iter().enumerate().find_map(|(i, o)| operation(&o.script_pubkey).map(|op| (i, op))) {
        let reason = format!("The request is {op} on Flush (output {index}), which this wallet can't show yet.");
        return Ok(Decoded::Blind { reason, verifiable_facts: facts });
    }
    match clear_view(&psbt, &keys, &kinds, fee) {
        Ok(view) => Ok(Decoded::Clear { view }),
        Err(why) => Ok(Decoded::Blind { reason: format!("The Flush Decoder can't fully explain this request: {why}"), verifiable_facts: facts }),
    }
}

fn verifiable_facts(psbt: &Psbt, keys: &AccountKeys, kinds: &[InputKind], fee: u64) -> VerifiableFacts {
    let mut owned_inputs = vec![];
    let mut leaving: i128 = 0;
    let mut unknown_fields = vec![];
    let mut dangerous_flags = vec![];

    unknown_fields.extend(psbt.unknown.keys().map(|k| format!("global: unknown field type 0x{:02x}", k.type_value)));
    unknown_fields.extend(psbt.proprietary.keys().map(|k| format!("global: proprietary field {}", String::from_utf8_lossy(&k.prefix))));

    for (i, (kind, input)) in kinds.iter().zip(&psbt.inputs).enumerate() {
        let value = spent(psbt, i).value.to_sat();
        match kind {
            InputKind::Yours { .. } => {
                owned_inputs.push(OwnedInput { index: i, asset: String::new(), amount: value.to_string() });
                leaving += value as i128;
            }
            InputKind::UnprovenClaim => dangerous_flags.push(format!(
                "input {i} claims one of this wallet's keys, but its key or script doesn't re-derive; it will not be signed"
            )),
            InputKind::Foreign => {}
        }
        if input.sighash_type.is_some_and(|t| t.ecdsa_hash_ty() != Ok(EcdsaSighashType::All)) {
            dangerous_flags.push(format!("input {i} asks for a non-default sighash"));
        }
        unknown_fields.extend(input.unknown.keys().map(|k| format!("input {i}: unknown field type 0x{:02x}", k.type_value)));
        unknown_fields.extend(input.proprietary.keys().map(|k| format!("input {i}: proprietary field {}", String::from_utf8_lossy(&k.prefix))));
    }

    for (i, (txout, output)) in psbt.unsigned_tx.output.iter().zip(&psbt.outputs).enumerate() {
        if output_yours(keys, output, txout) {
            leaving -= txout.value.to_sat() as i128;
        }
        unknown_fields.extend(output.unknown.keys().map(|k| format!("output {i}: unknown field type 0x{:02x}", k.type_value)));
        unknown_fields.extend(output.proprietary.keys().map(|k| format!("output {i}: proprietary field {}", String::from_utf8_lossy(&k.prefix))));
    }

    VerifiableFacts {
        owned_inputs,
        total_leaving: vec![AssetAmount::sats(leaving)],
        fee: vec![AssetAmount::sats(fee)],
        unknown_fields,
        dangerous_flags,
    }
}

/// The Clear View of `psbt` (already validated), or why the Decoder can't give one.
fn clear_view(psbt: &Psbt, keys: &AccountKeys, kinds: &[InputKind], fee: u64) -> Result<ClearView, String> {
    if psbt.version != 0 || !psbt.xpub.is_empty() {
        return Err("it has global fields the Decoder doesn't explain.".into());
    }

    let mut inputs = vec![];
    for (index, (kind, input)) in kinds.iter().zip(&psbt.inputs).enumerate() {
        if input.sighash_type.is_some_and(|t| t.ecdsa_hash_ty() != Ok(EcdsaSighashType::All)) {
            return Err(format!("input {index} asks for a sighash other than ALL."));
        }
        if matches!(kind, InputKind::UnprovenClaim) {
            return Err(format!("input {index} claims one of this wallet's keys, but it doesn't re-derive."));
        }
        if !only_explained_input_fields(input) {
            return Err(format!("input {index} has fields the Decoder doesn't explain."));
        }
        let yours = matches!(kind, InputKind::Yours { .. });
        inputs.push(ClearInput { index, asset: String::new(), amount: spent(psbt, index).value.to_sat().to_string(), yours });
    }

    let mut outputs = vec![];
    for (index, (txout, output)) in psbt.unsigned_tx.output.iter().zip(&psbt.outputs).enumerate() {
        if !only_explained_output_fields(output) {
            return Err(format!("output {index} has fields the Decoder doesn't explain."));
        }
        if txout.script_pubkey.is_op_return() {
            return Err(format!("output {index} is an OP_RETURN, which a plain payment doesn't have."));
        }
        let address = address(&txout.script_pubkey).ok_or_else(|| format!("output {index} pays a script that isn't an address."))?;
        let destination = Destination::Address { address, yours: output_yours(keys, output, txout) };
        outputs.push(ClearOutput { index, asset: String::new(), amount: txout.value.to_sat().to_string(), destination });
    }
    Ok(ClearView { dangerous_modes: vec![], inputs, outputs, fee: AssetAmount::sats(fee) })
}

/// True if `input` sets nothing beyond what a Clear View shows or `sign` needs. Unknown and
/// proprietary fields are reported (and make the request Blind) before this.
fn only_explained_input_fields(input: &Input) -> bool {
    let rest = Input {
        non_witness_utxo: None,
        witness_utxo: None,
        bip32_derivation: Default::default(),
        partial_sigs: Default::default(),
        sighash_type: None,
        proprietary: Default::default(),
        unknown: Default::default(),
        ..input.clone()
    };
    rest == Input::default()
}

/// True if `output` sets nothing beyond its derivation.
fn only_explained_output_fields(output: &Output) -> bool {
    let rest = Output { bip32_derivation: Default::default(), proprietary: Default::default(), unknown: Default::default(), ..output.clone() };
    rest == Output::default()
}
