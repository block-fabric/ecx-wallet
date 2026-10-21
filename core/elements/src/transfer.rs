//! `build_transfer(order, starter)`: the wallet's own Send over Esplora (#28, docs/adr/0006), as an
//! unsigned PSET for the normal review. `finalize(payload)` turns the signed PSET into the
//! transaction to broadcast.
//!
//! - Inputs: the account's own explicit coins, largest first per asset.
//! - Outputs: the payments in order, then change per asset (all to one change address, with its
//!   derivation so the Decoder shows it as yours), then the fee in the policy asset.
//!
//! The coins' values and assets come from the server (Esplora's `/utxo`); their scripts are
//! derived here from `chain`/`index`. A server that lies about either gets a transaction Elements
//! rejects, never a loss: Elements has no implicit fee (every asset's inputs must equal its
//! outputs), and the segwit-v0 sighash commits to each input's value.
use std::collections::BTreeMap;
use std::str::FromStr;

use elements_miniscript::bitcoin::bip32::KeySource;
use elements_miniscript::bitcoin::PublicKey;
use elements_miniscript::elements::confidential::{Asset, Nonce, Value};
use elements_miniscript::elements::encode::{serialize, serialize_hex};
use elements_miniscript::elements::hashes::Hash;
use elements_miniscript::elements::pset::raw::ProprietaryKey;
use elements_miniscript::elements::pset::{Input, Output, PartiallySignedTransaction};
use elements_miniscript::elements::secp256k1_zkp::{ecdsa, Message, Secp256k1};
use elements_miniscript::elements::sighash::SighashCache;
use elements_miniscript::elements::{
    Address, AssetId, BlockHash, EcdsaSighashType, OutPoint, PubkeyHash, Script, Transaction, TxIn, TxInWitness, TxOut,
    TxOutWitness, Txid,
};
use serde::{Deserialize, Serialize};

use crate::account::address_params;
use crate::decode::{refuse, validated, Refusal, RefusalCode};
use crate::network;
use crate::ownership::{p2wpkh, Wallet};

/// Elements Core's `DUST_RELAY_TX_FEE`, sats per 1000 vbytes (`src/policy/policy.h`; Bitcoin's is 3000).
const DUST_RELAY_FEE: u64 = 100;

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

/// One of the account's explicit outputs, as the server reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coin {
    /// Display hex.
    pub txid: String,
    pub vout: u32,
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub value: String,
    /// 0 receive, 1 change.
    pub chain: u32,
    pub index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payment {
    /// Display hex.
    pub asset: String,
    /// Base units, as a decimal string.
    pub amount: String,
    pub to: PaymentTo,
}

/// Where a payment goes. Only addresses for now; scripts and data can join without breaking the order.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum PaymentTo {
    /// In the chain's own encoding, unconfidential.
    Address(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    /// Base64.
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

/// The transaction `finalize` extracted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finalized {
    /// The raw transaction, hex: what Esplora's `POST /tx` takes.
    pub tx: String,
    pub txid: String,
}

fn malformed(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::Malformed, message)
}

fn starter_refusal(message: String) -> Refusal {
    refuse(RefusalCode::InvalidStarter, message)
}

fn asset_id(hex: &str, what: &str) -> Result<AssetId, Refusal> {
    AssetId::from_str(hex).map_err(|_| malformed(format!("{what} isn't an asset id: {hex}")))
}

fn base_units(amount: &str, what: &str) -> Result<u64, Refusal> {
    u64::from_str(amount).ok().filter(|a| *a > 0).ok_or_else(|| malformed(format!("{what} must be a whole number of base units above 0.")))
}

/// `amount` of `asset` as the user reads it: in the Chain Entry's units if it names the asset.
fn amount_text(asset: &AssetId, amount: u64) -> String {
    let id = asset.to_string();
    match network().assets.iter().find(|a| a.id == id) {
        Some(named) if named.decimals == 0 => format!("{amount} {}", named.ticker),
        Some(named) => {
            let scale = 10u64.pow(u32::from(named.decimals));
            format!("{}.{:0width$} {}", amount / scale, amount % scale, named.ticker, width = named.decimals as usize)
        }
        None => format!("{amount} base units of asset {}…", &id[..8]),
    }
}

fn explicit(script_pubkey: Script, asset: AssetId, value: u64) -> TxOut {
    TxOut { asset: Asset::Explicit(asset), value: Value::Explicit(value), nonce: Nonce::Null, script_pubkey, witness: TxOutWitness::default() }
}

/// Elements Core's `GetDustThreshold` at its `DUST_RELAY_TX_FEE`: what it costs to spend `txout`,
/// rounded up. Below it, an explicit output (of any asset) isn't relayed. Fee outputs are exempt.
pub(crate) fn dust_threshold(txout: &TxOut) -> u64 {
    if txout.script_pubkey.is_provably_unspendable() {
        return 0;
    }
    let spend = if txout.script_pubkey.is_witness_program() { 32 + 4 + 1 + 107 / 4 + 4 } else { 32 + 4 + 1 + 107 + 4 };
    ((serialize(txout).len() + spend) as u64 * DUST_RELAY_FEE).div_ceil(1000)
}

/// The destination as a script, refusing confidential and other networks' addresses.
fn destination_script(address: &str, i: usize) -> Result<Script, Refusal> {
    let parsed = Address::parse_with_params(address.trim(), address_params())
        .map_err(|e| malformed(format!("Output {i}: {address} isn't an address on {}: {e}", crate::chain_entry().name)))?;
    if parsed.blinding_pubkey.is_some() {
        let plain = Address { blinding_pubkey: None, ..parsed };
        return Err(refuse(
            RefusalCode::Confidential,
            format!("{address} is a confidential address; this wallet only sends to unconfidential ones. Its unconfidential form is {plain}."),
        ));
    }
    Ok(parsed.script_pubkey())
}

struct Spendable {
    outpoint: OutPoint,
    txout: TxOut,
    chain: u32,
    index: u32,
}

pub fn build_transfer(order_json: &str, starter: &str) -> Result<Built, Refusal> {
    let order: TransferOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid transfer order: {e}")))?;
    let wallet = Wallet::new(starter).map_err(starter_refusal)?;
    let policy = asset_id(&network().params.policy_asset, "The policy asset")?;
    if order.outputs.is_empty() {
        return Err(malformed("A transfer needs at least one output."));
    }

    let mut payments = vec![];
    let mut needed = BTreeMap::<AssetId, u64>::new();
    for (i, payment) in order.outputs.iter().enumerate() {
        let asset = asset_id(&payment.asset, &format!("Output {i}'s asset"))?;
        let amount = base_units(&payment.amount, &format!("Output {i}'s amount"))?;
        let PaymentTo::Address(address) = &payment.to;
        let txout = explicit(destination_script(address, i)?, asset, amount);
        let dust = dust_threshold(&txout);
        if amount < dust {
            return Err(refuse(
                RefusalCode::Dust,
                format!("{} is below the smallest amount Elements relays to {address} ({}).", amount_text(&asset, amount), amount_text(&asset, dust)),
            ));
        }
        let total = needed.entry(asset).or_default();
        *total = total.checked_add(amount).ok_or_else(|| malformed("The amounts are too large."))?;
        payments.push(txout);
    }

    let mut coins = BTreeMap::<AssetId, Vec<Spendable>>::new();
    for (i, coin) in order.coins.iter().enumerate() {
        let txid = Txid::from_str(&coin.txid).map_err(|_| malformed(format!("Coin {i}'s txid isn't one.")))?;
        if coin.chain > 1 {
            return Err(malformed(format!("Coin {i} names chain {}, not 0 (receive) or 1 (change).", coin.chain)));
        }
        let asset = asset_id(&coin.asset, &format!("Coin {i}'s asset"))?;
        let (pk, _) = wallet.key(coin.chain, coin.index).map_err(starter_refusal)?;
        let txout = explicit(p2wpkh(&pk), asset, base_units(&coin.value, &format!("Coin {i}'s value"))?);
        let outpoint = OutPoint::new(txid, coin.vout);
        if coins.values().flatten().any(|c| c.outpoint == outpoint) {
            return Err(malformed(format!("Coin {i} is listed twice.")));
        }
        coins.entry(asset).or_default().push(Spendable { outpoint, txout, chain: coin.chain, index: coin.index });
    }
    for list in coins.values_mut() {
        list.sort_by(|a, b| b.txout.value.explicit().cmp(&a.txout.value.explicit()).then(a.outpoint.cmp(&b.outpoint)));
    }
    let value = |c: &Spendable| c.txout.value.explicit().unwrap_or(0);

    let (change_pk, change_source) = wallet.key(1, order.change_index).map_err(starter_refusal)?;
    let change_script = p2wpkh(&change_pk);
    let change_output = |asset: AssetId, amount: u64| explicit(change_script.clone(), asset, amount);

    // Every other asset first: its coins and change don't depend on the fee.
    let mut chosen: Vec<&Spendable> = vec![];
    let mut changes: Vec<TxOut> = vec![];
    for (asset, need) in needed.iter().filter(|(asset, _)| **asset != policy) {
        let list = coins.get(asset).map(Vec::as_slice).unwrap_or_default();
        let mut total = 0u64;
        let mut count = 0;
        // Enough to pay, with change either none or above dust (it can't go to the fee).
        while total < *need || (total > *need && total - need < dust_threshold(&change_output(*asset, total - need))) {
            let Some(coin) = list.get(count) else {
                let code = if total >= *need { RefusalCode::Dust } else { RefusalCode::InsufficientFunds };
                let message = if total >= *need {
                    format!("Sending {} would leave {} as change, below what Elements relays.", amount_text(asset, *need), amount_text(asset, total - need))
                } else {
                    format!("Not enough {}: this needs {}, and the wallet can spend {}.", ticker(asset), amount_text(asset, *need), amount_text(asset, total))
                };
                return Err(refuse(code, message));
            };
            total += value(coin);
            count += 1;
        }
        chosen.extend(&list[..count]);
        if total > *need {
            changes.push(change_output(*asset, total - need));
        }
    }

    let need = needed.get(&policy).copied().unwrap_or(0);
    let unsigned = |policy_coins: &[Spendable], change: Option<u64>, fee: u64| {
        let inputs = chosen.iter().copied().chain(policy_coins);
        let mut output: Vec<TxOut> = payments.iter().cloned().chain(changes.iter().cloned()).collect();
        output.extend(change.map(|c| change_output(policy, c)));
        output.push(explicit(Script::new(), policy, fee));
        let input = inputs
            .map(|coin| TxIn {
                previous_output: coin.outpoint,
                is_pegin: false,
                script_sig: Script::new(),
                sequence: elements_miniscript::elements::Sequence::MAX,
                asset_issuance: Default::default(),
                witness: TxInWitness { script_witness: vec![vec![0u8; 72], vec![0u8; 33]], ..Default::default() },
            })
            .collect();
        Transaction { version: 2, lock_time: elements_miniscript::elements::LockTime::ZERO, input, output }
    };
    // The fee once signed: every input gets a witness of the largest size it can have.
    let fee = |tx: &Transaction| (tx.vsize() as u64 * order.fee_rate).div_ceil(1000);

    let policy_coins = coins.get(&policy).map(Vec::as_slice).unwrap_or_default();
    let mut total = 0u64;
    for count in 0..=policy_coins.len() {
        if count > 0 {
            total += value(&policy_coins[count - 1]);
        }
        let used = &policy_coins[..count];
        let with_change = fee(&unsigned(used, Some(1), 0));
        if let Some(change) = total.checked_sub(need + with_change).filter(|c| *c >= dust_threshold(&change_output(policy, *c))) {
            return pset(&unsigned(used, Some(change), with_change), &chosen, used, &wallet, (change_pk, change_source));
        }
        let without = fee(&unsigned(used, None, 0));
        if total >= need + without {
            // Change too small to relay goes to the fee.
            return pset(&unsigned(used, None, total - need), &chosen, used, &wallet, (change_pk, change_source));
        }
    }
    let with_fee = need + fee(&unsigned(policy_coins, None, 0));
    let (needs, can) = (amount_text(&policy, with_fee), amount_text(&policy, total));
    let message = if need == 0 {
        format!("Not enough {} to pay the fee: it needs {needs}, and the wallet can spend {can}.", ticker(&policy))
    } else {
        format!("Not enough {}: this needs {needs} with its fee, and the wallet can spend {can}.", ticker(&policy))
    };
    Err(refuse(RefusalCode::InsufficientFunds, message))
}

/// The asset's ticker, or "of asset <id>…" if the Chain Entry doesn't name it.
fn ticker(asset: &AssetId) -> String {
    let id = asset.to_string();
    network().assets.iter().find(|a| a.id == id).map_or_else(|| format!("of asset {}…", &id[..8]), |a| a.ticker.clone())
}

/// The PSET of `tx`: each input with its `witness_utxo` and derivation, the change outputs with theirs.
fn pset(
    tx: &Transaction,
    chosen: &[&Spendable],
    policy_coins: &[Spendable],
    wallet: &Wallet,
    (change_pk, change_source): (PublicKey, KeySource),
) -> Result<Built, Refusal> {
    let mut pset = PartiallySignedTransaction::new_v2();
    let mut spent = vec![];
    let genesis = BlockHash::from_str(&network().params.genesis_hash).expect("Chain Entry genesis is valid");
    pset.global.proprietary.insert(ProprietaryKey::from_pset_pair(0x02, vec![]), genesis.to_byte_array().to_vec());
    for coin in chosen.iter().copied().chain(policy_coins) {
        let mut input = Input::from_prevout(coin.outpoint);
        input.witness_utxo = Some(coin.txout.clone());
        let (pk, source) = wallet.key(coin.chain, coin.index).map_err(starter_refusal)?;
        input.bip32_derivation.insert(pk, source);
        pset.add_input(input);
        spent.push(Spent { txid: coin.outpoint.txid.to_string(), vout: coin.outpoint.vout });
    }
    for txout in &tx.output {
        let mut output = Output::new_explicit(txout.script_pubkey.clone(), txout.value.explicit().unwrap_or(0), txout.asset.explicit().expect("explicit"), None);
        if txout.script_pubkey == p2wpkh(&change_pk) {
            output.bip32_derivation.insert(change_pk, change_source.clone());
        }
        pset.add_output(output);
    }
    Ok(Built { pset: pset.to_string(), spent })
}

/// Finalizes every input and extracts the transaction. Each input must be P2WPKH with a valid
/// SIGHASH_ALL signature from the key its output pays; anything else is refused: the module only
/// completes what it can check.
pub fn finalize(payload: &str) -> Result<Finalized, Refusal> {
    let mut pset = validated(payload)?;
    let secp = Secp256k1::verification_only();
    let tx = pset.extract_tx().map_err(|e| malformed(format!("Can't read the transaction: {e}")))?;
    let mut cache = SighashCache::new(&tx);
    for (i, input) in pset.inputs_mut().iter_mut().enumerate() {
        let spent = input.witness_utxo.clone().expect("validated: every input has witness_utxo");
        if !spent.script_pubkey.is_v0_p2wpkh() {
            return Err(malformed(format!("Input {i} spends a script this wallet can't finalize.")));
        }
        let (pk, raw) = input
            .partial_sigs
            .iter()
            .find(|(pk, _)| p2wpkh(pk) == spent.script_pubkey)
            .map(|(pk, sig)| (*pk, sig.clone()))
            .ok_or_else(|| malformed(format!("Input {i} isn't signed.")))?;
        let invalid = || malformed(format!("Input {i}'s signature isn't valid."));
        let (sighash_byte, der) = raw.split_last().ok_or_else(invalid)?;
        if *sighash_byte != 0x01 {
            return Err(invalid());
        }
        let script_code = Script::new_p2pkh(&PubkeyHash::hash(&pk.inner.serialize()));
        let sighash = cache.segwitv0_sighash(i, &script_code, spent.value, EcdsaSighashType::All);
        let signature = ecdsa::Signature::from_der(der).map_err(|_| invalid())?;
        secp.verify_ecdsa(&Message::from_digest(sighash.to_byte_array()), &signature, &pk.inner).map_err(|_| invalid())?;
        input.final_script_witness = Some(vec![raw, pk.inner.serialize().to_vec()]);
        input.partial_sigs.clear();
        input.bip32_derivation.clear();
        input.sighash_type = None;
    }
    let tx = pset.extract_tx().map_err(|e| malformed(format!("Can't extract the transaction: {e}")))?;
    Ok(Finalized { tx: serialize_hex(&tx), txid: tx.txid().to_string() })
}
