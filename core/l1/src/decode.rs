//! `decode(payload, account_key)`: the L1 Decoder. A Clear View of a request it fully understands,
//! or `Blind { reason, verifiableFacts }`; never a partial Clear View.
//!
//! It understands payments to addresses and Deposits (M5s): a Treasury output
//! `OP_DRIVECHAIN <slot> OP_TRUE`, directly followed by a single-push `OP_RETURN` naming where the
//! Slot credits it, spending the Slot's previous Treasury if the request has one. Whether an input
//! or output is "yours" is decided only by re-deriving it from the L1 Account Key, never by the
//! requester. Every amount comes from the previous transactions the PSBT carries, which `validated`
//! checked against their txids.
use std::collections::{BTreeMap, BTreeSet};

use bitcoin::psbt::{Input, Output, Psbt};
use bitcoin::secp256k1::PublicKey;
use bitcoin::{EcdsaSighashType, TxOut};
use serde::Serialize;

use crate::psbt::{op_return_data, refuse, spent, treasury_slot, validated, AssetAmount, OwnedInput, Refusal, RefusalCode};
use crate::{address, hex, AccountKeys};

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
    /// Inputs that re-derive to the L1 Account Key (the only ones `sign` will sign).
    pub owned_inputs: Vec<OwnedInput>,
    /// Owned inputs minus outputs that re-derive to the key. Negative means more comes back.
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
    /// Risky modes, to be shown above everything else.
    pub dangerous_modes: Vec<DangerousMode>,
    pub inputs: Vec<ClearInput>,
    /// Every output, except a Deposit's address output (part of its Deposit).
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
    /// Re-derives to the L1 Account Key: `sign` signs it.
    pub yours: bool,
    /// The Slot whose Treasury this input spends (and the request recreates).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub treasury: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutput {
    pub index: usize,
    /// Always "".
    pub asset: String,
    /// The output's value in sats, as a decimal string. For a Deposit, the Slot's whole new Treasury.
    pub amount: String,
    pub destination: Destination,
}

/// Where an output's funds go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Destination {
    /// An L1 address; `yours` only if it re-derives to the L1 Account Key.
    Address { address: String, yours: bool },
    /// A Deposit (M5) of `deposit` sats to `slot`: the Treasury grows from `treasury_before` by it.
    /// The Slot credits it to whatever `data` names, in its own encoding; the wallet checks that
    /// against the Slot's Chain Module.
    #[serde(rename_all = "camelCase")]
    Deposit {
        slot: u8,
        /// Sats, as a decimal string.
        deposit: String,
        /// Sats, as a decimal string; "0" for the Slot's first Deposit.
        treasury_before: String,
        /// The `OP_RETURN` output holding the destination.
        data_output: usize,
        /// The destination bytes, hex.
        data: String,
        /// The destination bytes as text, if they are printable UTF-8 (an Elements address is).
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
}

/// A risky mode of the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DangerousMode {
    /// A Deposit: the funds leave L1, and only come back through a Withdrawal (a BIP300 miner vote
    /// of months).
    Deposit { output: usize },
    /// A Deposit that spends no Treasury, as only a Slot's first may. If the Slot isn't active, or
    /// already has a Treasury, the funds can be lost.
    FirstDeposit { output: usize },
}

/// What an input is, decided by re-deriving it.
pub(crate) enum InputKind {
    Yours { chain: u32, index: u32, pubkey: PublicKey },
    /// Spends `slot`'s Treasury.
    Treasury(u8),
    /// Names the key's fingerprint, but doesn't re-derive: never signed.
    UnprovenClaim,
    Foreign,
}

pub(crate) fn classify_input(keys: &AccountKeys, input: &Input, spent: &TxOut) -> InputKind {
    for (pubkey, source) in &input.bip32_derivation {
        if let Some((chain, index)) = keys.owns(pubkey, source, &spent.script_pubkey) {
            return InputKind::Yours { chain, index, pubkey: *pubkey };
        }
    }
    if input.bip32_derivation.values().any(|source| keys.claims(source)) {
        return InputKind::UnprovenClaim;
    }
    match treasury_slot(&spent.script_pubkey) {
        Some(slot) => InputKind::Treasury(slot),
        None => InputKind::Foreign,
    }
}

fn output_yours(keys: &AccountKeys, output: &Output, txout: &TxOut) -> bool {
    output.bip32_derivation.iter().any(|(pubkey, source)| keys.owns(pubkey, source, &txout.script_pubkey).is_some())
}

pub fn decode(payload: &str, account_key: &str) -> Result<Decoded, Refusal> {
    let psbt = validated(payload)?;
    let keys = AccountKeys::new(account_key).map_err(|e| refuse(RefusalCode::InvalidAccountKey, e))?;
    let kinds: Vec<_> = (0..psbt.inputs.len()).map(|i| classify_input(&keys, &psbt.inputs[i], spent(&psbt, i))).collect();
    let inputs_total: u64 = (0..psbt.inputs.len()).map(|i| spent(&psbt, i).value.to_sat()).sum();
    let outputs_total: u64 = psbt.unsigned_tx.output.iter().map(|o| o.value.to_sat()).sum();
    let fee = inputs_total
        .checked_sub(outputs_total)
        .ok_or_else(|| refuse(RefusalCode::Malformed, "The outputs add up to more than the inputs."))?;

    let facts = verifiable_facts(&psbt, &keys, &kinds, fee);
    if !facts.unknown_fields.is_empty() {
        let reason = "The request contains fields the L1 Decoder doesn't understand.";
        return Ok(Decoded::Blind { reason: reason.into(), verifiable_facts: facts });
    }
    match clear_view(&psbt, &keys, &kinds, fee) {
        Ok(view) => Ok(Decoded::Clear { view }),
        Err(why) => Ok(Decoded::Blind { reason: format!("The L1 Decoder can't fully explain this request: {why}"), verifiable_facts: facts }),
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
            InputKind::Treasury(_) | InputKind::Foreign => {}
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
        if let Some(slot) = treasury_slot(&txout.script_pubkey) {
            dangerous_flags.push(format!("output {i} pays Slot {slot}'s Treasury: a Deposit, which only comes back through a Withdrawal"));
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
    let mut treasuries = BTreeMap::<u8, u64>::new();
    for (index, (kind, input)) in kinds.iter().zip(&psbt.inputs).enumerate() {
        let value = spent(psbt, index).value.to_sat();
        if input.sighash_type.is_some_and(|t| t.ecdsa_hash_ty() != Ok(EcdsaSighashType::All)) {
            return Err(format!("input {index} asks for a sighash other than ALL."));
        }
        let treasury = match kind {
            InputKind::UnprovenClaim => return Err(format!("input {index} claims one of this wallet's keys, but it doesn't re-derive.")),
            InputKind::Treasury(slot) => {
                if input.final_script_sig.as_ref().is_some_and(|script| !script.is_empty()) {
                    return Err(format!("input {index} spends a Treasury with a scriptSig."));
                }
                if treasuries.insert(*slot, value).is_some() {
                    return Err(format!("it spends Slot {slot}'s Treasury twice."));
                }
                Some(*slot)
            }
            InputKind::Yours { .. } | InputKind::Foreign => None,
        };
        if !only_explained_input_fields(input, treasury.is_some()) {
            return Err(format!("input {index} has fields the Decoder doesn't explain."));
        }
        let yours = matches!(kind, InputKind::Yours { .. });
        inputs.push(ClearInput { index, asset: String::new(), amount: value.to_string(), yours, treasury });
    }

    let mut dangerous_modes = vec![];
    let mut outputs = vec![];
    let mut deposited = BTreeSet::<u8>::new();
    let txouts = &psbt.unsigned_tx.output;
    let mut index = 0;
    while index < txouts.len() {
        let (txout, output) = (&txouts[index], &psbt.outputs[index]);
        if !only_explained_output_fields(output) {
            return Err(format!("output {index} has fields the Decoder doesn't explain."));
        }
        let value = txout.value.to_sat();
        let destination = if let Some(slot) = treasury_slot(&txout.script_pubkey) {
            let data = txouts
                .get(index + 1)
                .filter(|next| next.value.to_sat() == 0 && only_explained_output_fields(&psbt.outputs[index + 1]))
                .and_then(|next| op_return_data(&next.script_pubkey))
                .ok_or_else(|| format!("output {index} pays Slot {slot}'s Treasury, but no deposit address follows it."))?;
            if !deposited.insert(slot) {
                return Err(format!("it pays Slot {slot}'s Treasury twice."));
            }
            let before = treasuries.get(&slot).copied();
            let deposit = value
                .checked_sub(before.unwrap_or(0))
                .filter(|d| *d > 0)
                .ok_or_else(|| format!("output {index} doesn't grow Slot {slot}'s Treasury, so it isn't a Deposit."))?;
            dangerous_modes.push(DangerousMode::Deposit { output: index });
            if before.is_none() {
                dangerous_modes.push(DangerousMode::FirstDeposit { output: index });
            }
            let text = std::str::from_utf8(&data).ok().filter(|t| !t.is_empty() && !t.chars().any(char::is_control)).map(String::from);
            let destination = Destination::Deposit {
                slot,
                deposit: deposit.to_string(),
                treasury_before: before.unwrap_or(0).to_string(),
                data_output: index + 1,
                data: hex(&data),
                text,
            };
            outputs.push(ClearOutput { index, asset: String::new(), amount: value.to_string(), destination });
            index += 2;
            continue;
        } else if txout.script_pubkey.is_op_return() {
            return Err(format!("output {index} is an OP_RETURN that isn't a deposit address."));
        } else {
            let address = address(&txout.script_pubkey).ok_or_else(|| format!("output {index} pays a script that isn't an address."))?;
            Destination::Address { address, yours: output_yours(keys, output, txout) }
        };
        outputs.push(ClearOutput { index, asset: String::new(), amount: value.to_string(), destination });
        index += 1;
    }
    if let Some(slot) = treasuries.keys().find(|slot| !deposited.contains(slot)) {
        return Err(format!("it spends Slot {slot}'s Treasury without recreating it."));
    }
    Ok(ClearView { dangerous_modes, inputs, outputs, fee: AssetAmount::sats(fee) })
}

/// True if `input` sets nothing beyond what a Clear View shows or `sign` needs. A Treasury input
/// may also carry its (empty) final scriptSig. Unknown and proprietary fields are reported (and
/// make the request Blind) before this.
fn only_explained_input_fields(input: &Input, treasury: bool) -> bool {
    let rest = Input {
        non_witness_utxo: None,
        witness_utxo: None,
        bip32_derivation: Default::default(),
        partial_sigs: Default::default(),
        sighash_type: None,
        final_script_sig: if treasury { None } else { input.final_script_sig.clone() },
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
