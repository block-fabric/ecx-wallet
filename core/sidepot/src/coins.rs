//! Ordinary Sidepot coins (docs/adr/0022). Besides its game accounts, the Sidepot sidechain has
//! coins held by 20-byte addresses: a game cashout arrives as one, and only a coin can ask for a
//! withdrawal to the main chain. This is the wallet's address there, and its three spends:
//!
//! - [`coin_address`] turns the Slot's Starter into the wallet's one Sidepot address;
//! - [`build_spend`] builds, unsigned, a transfer to another Sidepot address, a withdrawal request
//!   to a main-chain address, or a move into a game account (the node's `GameDeposit` output,
//!   docs/adr/0023), from the coins a server lists, with change back to the same address;
//! - [`decode_spend`] says what such a spend does, checked from its own bytes, for the approval;
//! - [`sign_spend`] checks it the same way, then signs it as the node takes it.
//!
//! The formats are the node's (`thunder.rs`). The wallet follows no chain: the node attaches each
//! transaction's Utreexo proof when it takes it.
use std::collections::BTreeSet;
use std::str::FromStr;

use bech32::Hrp;
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{Secp256k1, XOnlyPublicKey};
use bitcoin::{NetworkKind, ScriptBuf, WitnessProgram, WitnessVersion};
use curve25519_dalek::scalar::Scalar;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::thunder::{authorized_json, node_script, verify, Address, Authorization, Content, OutPoint, Output, PointedOutput, SigningKey, Transaction};
use crate::{hex, network, refuse, Refusal, RefusalCode, ACCOUNT_PREFIX};

/// Where the coin key's seed sits under the Starter's BIP39 seed (no passphrase): beside the game
/// account (`ACCOUNT_PATH`, account 0), at account 1, hardened. The path is the same on every network.
pub const COIN_PATH: &str = "300h/88h/1h";

/// BLAKE3's key-derivation context for the coin key: the BIP32 private key at [`COIN_PATH`] goes
/// in, and 64 bytes come out to be reduced onto ristretto255's scalar field.
pub const COIN_KEY_CONTEXT: &str = "ECX Wallet 2026-11-20 Sidepot coin key v1";

/// BLAKE3's key-derivation context for the key a signature's nonce is drawn with.
const NONCE_KEY_CONTEXT: &str = "ECX Wallet 2026-11-20 Sidepot coin signature nonce v1";

/// Bitcoin Core's `DUST_RELAY_TX_FEE`, sats per 1000 vbytes: a withdrawal paying less on the main
/// chain than its output costs to spend at this rate would make its whole bundle one the main
/// chain doesn't relay.
const DUST_RELAY_FEE: u64 = 3_000;

/// The Starter's Sidepot coin key.
struct CoinKey {
    key: SigningKey,
    nonce_key: [u8; 32],
}

impl CoinKey {
    /// The Starter (a 12-word BIP39 mnemonic) → its BIP39 seed with no passphrase → the BIP32
    /// private key at `m/300'/88'/1'` → BLAKE3 in key-derivation mode, 64 bytes, reduced onto the
    /// scalar field. Every Starter gives a key: zero, which is none, would take 2^-252 luck.
    fn new(starter: &str) -> Result<Self, String> {
        let mnemonic = bip39::Mnemonic::parse_in(bip39::Language::English, starter).map_err(|e| format!("invalid Starter: {e}"))?;
        let master = Xpriv::new_master(NetworkKind::Main, &mnemonic.to_seed("")).map_err(|e| format!("invalid Starter: {e}"))?;
        let path = DerivationPath::from_str(&format!("m/{COIN_PATH}")).expect("valid path");
        let seed = master.derive_priv(&Secp256k1::new(), &path).map_err(|e| e.to_string())?.private_key.secret_bytes();
        let mut wide = [0u8; 64];
        blake3::Hasher::new_derive_key(COIN_KEY_CONTEXT).update(&seed).finalize_xof().fill(&mut wide);
        let scalar = Scalar::from_bytes_mod_order_wide(&wide);
        let key = SigningKey::from_scalar(scalar).ok_or("this Starter has no Sidepot coin key")?;
        Ok(CoinKey { key, nonce_key: blake3::derive_key(NONCE_KEY_CONTEXT, scalar.as_bytes()) })
    }

    fn address(&self) -> Address {
        self.key.address()
    }

    /// Signs without randomness, which a module here has none of: the nonce is BLAKE3 keyed by a
    /// key derived from the signing key, over the message, reduced onto the scalar field. So one
    /// message always gets one nonce and one signature, as Ed25519 and RFC 6979 do it.
    fn sign(&self, message: &[u8]) -> Result<[u8; 64], Refusal> {
        let mut wide = [0u8; 64];
        blake3::Hasher::new_keyed(&self.nonce_key).update(message).finalize_xof().fill(&mut wide);
        let signature = self.key.sign_with_nonce(&Scalar::from_bytes_mod_order_wide(&wide), message);
        signature.filter(|s| verify(&self.key.verifying_key(), message, s)).ok_or_else(|| malformed("The signature the wallet made doesn't verify."))
    }
}

fn malformed(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::Malformed, message)
}

/// The wallet's Sidepot address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoinAddress {
    /// As the node writes it: base58 of its 20 bytes.
    pub address: String,
    /// Those 20 bytes in hex: what a `sidepot:cashout` link's `dest` takes.
    pub hex: String,
    /// The verifying key the address is of: 32 bytes, a compressed ristretto255 point, hex.
    pub public_key: String,
}

/// The Starter → the wallet's one Sidepot address, where its coins are and its change returns.
pub fn coin_address(starter: &str) -> Result<CoinAddress, String> {
    let key = CoinKey::new(starter)?;
    let address = key.address();
    Ok(CoinAddress { address: address.base58(), hex: hex(&address.0), public_key: hex(&key.key.verifying_key()) })
}

/// The Starter's Sidepot address, for the module's own checks (a cashout's destination).
pub(crate) fn own_address(starter: &str) -> Result<Address, String> {
    Ok(CoinKey::new(starter)?.address())
}

/// What to pay, and what to build it from.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpendOrder {
    /// The address's coins as its server lists them (the node's `list_utxos`). Only its own plain
    /// coins are spent: a withdrawal request waiting to be bundled, or anyone else's coin, is left out.
    pub coins: Vec<Value>,
    pub pay: Payment,
    /// The Sidepot fee, sats, as a decimal string: what the inputs hold beyond the outputs.
    pub fee: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Payment {
    /// `amount` sats to the Sidepot address `to`.
    Transfer { to: String, amount: String },
    /// A request to withdraw `amount` sats to the main-chain address `main_address`, with
    /// `main_fee` sats more for the main chain's miners.
    Withdrawal { main_address: String, amount: String, main_fee: String },
    /// `amount` sats moved into the Starter's own game account (docs/adr/0023). The wallet builds
    /// no move into anyone else's: a payload that names another is decoded as not yours.
    Game { amount: String },
}

/// A spend `build_spend` built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltSpend {
    /// The unsigned spend, JSON: `{ transaction, coins }`, the transaction as the node reads one
    /// and the coins it spends, in its inputs' order. What `decode_spend` and `sign_spend` take.
    pub payload: String,
    /// The outpoints it spends, as the server listed them: what the wallet holds back until it is in a block.
    pub spent: Vec<Value>,
}

/// A spend `sign_spend` signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedSpend {
    /// The node's `Authorized<Transaction>`, JSON: the body of the server's `POST /tx`.
    pub tx: String,
    /// The txid the node will know it by: the BLAKE3 of its canonical bytes, hex.
    pub txid: String,
}

/// A decimal string of sats, as the wallet writes amounts: plain digits that fit 64 bits.
fn sats(text: &str, what: &str) -> Result<u64, Refusal> {
    let plain = !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    plain.then(|| text.parse().ok()).flatten().ok_or_else(|| malformed(format!("{what} must be a whole number of sats.")))
}

/// `sats` as the user reads it.
fn ecx(sats: u64) -> String {
    format!("{}.{:08} ECX", sats / 100_000_000, sats % 100_000_000)
}

/// The main chain's address encoding on this network: the Chain Entry's `parentAddressParams`.
fn parent() -> &'static crate::chain_entry::AddressParams {
    &network().params.parent_address_params
}

/// `address`'s script, if it is a main-chain address of this network the wallet pays (as the L1
/// module's own Send): P2PKH and P2SH in base58check, segwit v0 (P2WPKH, P2WSH) and v1 (P2TR) in
/// bech32/bech32m. And only if the node reads the same script from it.
pub fn main_script(address: &str) -> Option<ScriptBuf> {
    let params = parent();
    let script = if let Ok((hrp, version, program)) = bech32::segwit::decode(address) {
        if hrp != Hrp::parse(&params.bech_hrp).ok()? {
            return None;
        }
        let version = WitnessVersion::try_from(version).ok()?;
        let program = WitnessProgram::new(version, &program).ok()?;
        let known = match version {
            WitnessVersion::V0 => true,
            WitnessVersion::V1 => program.program().len() == 32,
            _ => false,
        };
        known.then(|| ScriptBuf::new_witness_program(&program))?
    } else {
        let data = bitcoin::base58::decode_check(address).ok()?;
        let (prefix, hash) = data.split_first()?;
        let hash: [u8; 20] = hash.try_into().ok()?;
        match *prefix {
            p if p == params.p2pkh_prefix => ScriptBuf::new_p2pkh(&bitcoin::PubkeyHash::from_byte_array(hash)),
            p if p == params.p2sh_prefix => ScriptBuf::new_p2sh(&bitcoin::ScriptHash::from_byte_array(hash)),
            _ => return None,
        }
    };
    (node_script(address).as_deref() == Some(script.as_bytes())).then_some(script)
}

/// `script` as a main-chain address in this network's encoding. None for any other script.
pub fn main_address(script: &[u8]) -> Option<String> {
    let params = parent();
    let base58 = |prefix: u8, hash: &[u8]| Some(bitcoin::base58::encode_check(&[&[prefix][..], hash].concat()));
    match script {
        [0x76, 0xa9, 0x14, hash @ .., 0x88, 0xac] if hash.len() == 20 => base58(params.p2pkh_prefix, hash),
        [0xa9, 0x14, hash @ .., 0x87] if hash.len() == 20 => base58(params.p2sh_prefix, hash),
        [version @ (0x00 | 0x51), len, program @ ..] if *len as usize == program.len() => {
            let version = bech32::Fe32::try_from(if *version == 0 { 0 } else { version - 0x50 }).ok()?;
            bech32::segwit::encode(Hrp::parse(&params.bech_hrp).ok()?, version, program).ok()
        }
        _ => None,
    }
}

/// True if `account` is a key a game account can have: an x-only (BIP340) public key. The node
/// refuses a game deposit to anything else, since nobody could ever sign for it.
fn is_game_account(account: &[u8; 32]) -> bool {
    XOnlyPublicKey::from_slice(account).is_ok()
}

/// Bitcoin Core's `GetDustThreshold` at its `DUST_RELAY_TX_FEE` for an output paying `script`:
/// what it costs to spend, rounded up (546 sats for P2PKH, 294 for P2WPKH).
fn dust_threshold(script: &ScriptBuf) -> u64 {
    let output = 8 + 1 + script.len();
    let spend = if script.is_witness_program() { 32 + 4 + 1 + 107 / 4 + 4 } else { 32 + 4 + 1 + 107 + 4 };
    ((output + spend) as u64 * DUST_RELAY_FEE).div_ceil(1000)
}

/// Builds `order`'s spend from the Starter's coins among those listed: the largest first, until
/// they cover the payment and the fee; what is left over returns to the same address. Unsigned.
pub fn build_spend(order_json: &str, starter: &str) -> Result<BuiltSpend, Refusal> {
    let order: SpendOrder = serde_json::from_str(order_json).map_err(|e| malformed(format!("Invalid spend order: {e}")))?;
    let key = CoinKey::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let me = key.address();
    let fee = sats(&order.fee, "The fee")?;

    let payment = match &order.pay {
        Payment::Transfer { to, amount } => {
            let amount = sats(amount, "The amount")?;
            let to = to.trim();
            let address = Address::parse(to).ok_or_else(|| malformed(format!("{to} isn't a Sidepot address: one is 20 bytes in base58, about 27 characters.")))?;
            if amount == 0 {
                return Err(malformed("The amount to send must be more than 0."));
            }
            Output { address, content: Content::Value(amount) }
        }
        Payment::Withdrawal { main_address: to, amount, main_fee } => {
            let (value, main_fee) = (sats(amount, "The amount")?, sats(main_fee, "The main-chain fee")?);
            let to = to.trim();
            let script = main_script(to).ok_or_else(|| malformed(format!("{to} isn't a main-chain (eCash) address this wallet withdraws to.")))?;
            let dust = dust_threshold(&script);
            if value < dust {
                return Err(refuse(RefusalCode::Dust, format!("A withdrawal to {to} must pay at least {} ({dust} sats): the main chain doesn't relay a smaller payment.", ecx(dust))));
            }
            if main_fee == 0 {
                return Err(malformed("A withdrawal needs a main-chain fee: it is what pays the main chain's miners to include it."));
            }
            // The request stays the wallet's own on Sidepot until the chain bundles it.
            let main_address = main_address(script.as_bytes()).expect("a script main_script made");
            Output { address: me, content: Content::Withdrawal { value, main_fee, main_address, script: script.into_bytes() } }
        }
        Payment::Game { amount } => {
            let value = sats(amount, "The amount")?;
            let account = crate::own_account(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
            if value == 0 {
                return Err(malformed("The amount to move into the game must be more than 0."));
            }
            // No coin, and nobody's to hold: the node takes it only at the address of all zeros.
            Output { address: Address::ALL_ZEROS, content: Content::GameDeposit { value, account } }
        }
    };
    let overflow = || malformed("The amounts are more ECX than exists.");
    let need = payment.content.consumed().and_then(|paid| paid.checked_add(fee)).ok_or_else(overflow)?;

    // The wallet's own plain coins, each once, largest first (ties in the outpoints' own order).
    let mut mine = vec![];
    let mut listed_outpoints = BTreeSet::new();
    for listed in &order.coins {
        let coin = PointedOutput::from_json(listed).map_err(|e| malformed(format!("The server listed a coin this wallet can't read: {e}.")))?;
        if !listed_outpoints.insert(coin.outpoint) {
            return Err(malformed("The server listed the same coin twice."));
        }
        if let (true, Content::Value(value)) = (coin.output.address == me, &coin.output.content) {
            if *value > 0 {
                mine.push((*value, coin));
            }
        }
    }
    mine.sort_by(|(a_value, a), (b_value, b)| b_value.cmp(a_value).then(a.outpoint.cmp(&b.outpoint)));
    let mut total = 0u64;
    let mut spent = vec![];
    for (value, coin) in mine {
        if total >= need {
            break;
        }
        total = total.checked_add(value).ok_or_else(overflow)?;
        spent.push(coin);
    }
    if total < need {
        let paid = need - fee;
        return Err(refuse(
            RefusalCode::InsufficientFunds,
            format!("Your Sidepot coins hold {}, and this needs {}: {} and the {} fee.", ecx(total), ecx(need), ecx(paid), ecx(fee)),
        ));
    }

    let mut outputs = vec![payment];
    if total > need {
        outputs.push(Output { address: me, content: Content::Value(total - need) });
    }
    let transaction = Transaction { inputs: spent.iter().map(|coin| (coin.outpoint, coin.hash())).collect(), outputs };
    let payload = serde_json::json!({ "transaction": transaction.to_json(), "coins": spent.iter().map(PointedOutput::to_json).collect::<Vec<_>>() });
    Ok(BuiltSpend { payload: payload.to_string(), spent: spent.iter().map(|coin| coin.outpoint.to_json()).collect() })
}

/// An amount of Sidepot's one coin, in the shape every Chain Module's view has: `asset` is always "".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Sats {
    pub asset: String,
    /// Sats, as a decimal string.
    pub amount: String,
}

fn amount(sats: u64) -> Sats {
    Sats { asset: String::new(), amount: sats.to_string() }
}

/// What a spend does, in the shape of every Chain Module's Clear View (`ClearView` in the wallet).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendView {
    /// A withdrawal request, which can't be taken back: `withdrawalBurn` for its output.
    pub dangerous_modes: Vec<DangerousMode>,
    /// The coins spent: all the wallet's own, or the spend is refused.
    pub inputs: Vec<ViewInput>,
    pub outputs: Vec<ViewOutput>,
    /// What the inputs hold beyond the outputs: Sidepot's fee.
    pub fee: Sats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DangerousMode {
    WithdrawalBurn { output: usize },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewInput {
    pub index: usize,
    #[serde(flatten)]
    pub amount: Sats,
    pub yours: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewOutput {
    pub index: usize,
    /// What it takes from the inputs: for a withdrawal request, its payout and its main-chain fee.
    #[serde(flatten)]
    pub amount: Sats,
    pub destination: Destination,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Destination {
    /// A Sidepot address; `yours` if it is the Starter's own.
    Address { address: String, yours: bool },
    /// A withdrawal request: `payout` sats to `l1_address` on the main chain (`l1_script_pubkey`,
    /// hex, is its script), `parent_fee` sats to the main chain's miners.
    Withdrawal { l1_address: String, l1_script_pubkey: String, payout: String, parent_fee: String },
    /// A game account (docs/adr/0023): the output's sats are credited to it, and are no coin from
    /// then on. `account` is its x-only key, hex; `address` the account as the wallet writes one,
    /// `spot:<key>`; `yours` if it is the Starter's own game account.
    GameAccount { account: String, address: String, yours: bool },
}

/// `decode_spend`'s answer: always a Clear View, or a refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Decoded {
    Clear { view: SpendView },
}

/// Reads an unsigned spend and checks it from its own bytes: every input spends one of the coins
/// given, by that coin's hash; every coin is a plain coin of the Starter's address, spent once; a
/// withdrawal pays a main-chain address of this network; a move into the game is one the node
/// takes (above zero, to a real account, at the address of all zeros), marked as the Starter's own
/// account (`my_account`) or not; and the inputs cover the outputs.
fn read(payload: &str, key: &CoinKey, my_account: &[u8; 32]) -> Result<(Transaction, SpendView), Refusal> {
    let value: Value = serde_json::from_str(payload).map_err(|e| malformed(format!("Not a Sidepot spend: {e}")))?;
    let fields = value.as_object().filter(|o| o.len() == 2).ok_or_else(|| malformed("Not a Sidepot spend."))?;
    let (Some(transaction), Some(coins)) = (fields.get("transaction"), fields.get("coins").and_then(Value::as_array)) else {
        return Err(malformed("Not a Sidepot spend."));
    };
    let transaction = Transaction::from_json(transaction).map_err(|e| malformed(format!("Not a Sidepot spend: {e}.")))?;
    let coins: Vec<PointedOutput> = coins.iter().map(PointedOutput::from_json).collect::<Result<_, _>>().map_err(|e| malformed(format!("Not a Sidepot spend: {e}.")))?;
    let me = key.address();

    if transaction.inputs.is_empty() || transaction.inputs.len() != coins.len() {
        return Err(malformed("A Sidepot spend names the coin of each of its inputs, and has at least one."));
    }
    if transaction.outputs.is_empty() {
        return Err(malformed("A Sidepot spend pays at least one output."));
    }
    let mut seen: Vec<OutPoint> = vec![];
    let mut inputs = vec![];
    let mut total = 0u64;
    let overflow = || malformed("The amounts are more ECX than exists.");
    for (index, ((outpoint, hash), coin)) in transaction.inputs.iter().zip(&coins).enumerate() {
        if *outpoint != coin.outpoint || *hash != coin.hash() {
            return Err(malformed(format!("Input {index} doesn't spend the coin given for it.")));
        }
        if seen.contains(outpoint) {
            return Err(malformed(format!("Input {index} spends a coin another input already spends.")));
        }
        seen.push(*outpoint);
        let value = match coin.output.content {
            Content::Value(value) => value,
            Content::Withdrawal { .. } => return Err(malformed(format!("Input {index} spends a withdrawal request, which no one can spend."))),
            Content::GameDeposit { .. } => return Err(malformed(format!("Input {index} spends a move into the game, which is no coin."))),
        };
        if coin.output.address != me {
            return Err(refuse(RefusalCode::NothingToSign, format!("Input {index} spends a coin of {}, which isn't this wallet's address.", coin.output.address.base58())));
        }
        total = total.checked_add(value).ok_or_else(overflow)?;
        inputs.push(ViewInput { index, amount: amount(value), yours: true });
    }

    let mut dangerous_modes = vec![];
    let mut outputs = vec![];
    let mut paid = 0u64;
    for (index, output) in transaction.outputs.iter().enumerate() {
        let consumed = output.content.consumed().ok_or_else(overflow)?;
        paid = paid.checked_add(consumed).ok_or_else(overflow)?;
        let destination = match &output.content {
            Content::Value(_) => Destination::Address { address: output.address.base58(), yours: output.address == me },
            Content::GameDeposit { value, account } => {
                // Each of these the node refuses: better here, before anything is shown or signed.
                if *value == 0 {
                    return Err(malformed(format!("Output {index} moves nothing into the game: the amount must be more than 0.")));
                }
                if output.address != Address::ALL_ZEROS {
                    return Err(malformed(format!("Output {index} moves coins into the game, but names an address: a move into the game has none.")));
                }
                if !is_game_account(account) {
                    return Err(malformed(format!("Output {index} moves coins into {}, which isn't a game account anyone could have.", hex(account))));
                }
                Destination::GameAccount { account: hex(account), address: format!("{ACCOUNT_PREFIX}{}", hex(account)), yours: account == my_account }
            }
            Content::Withdrawal { value, main_fee, main_address: to, script } => {
                // Refused unless it reads as an address of this network, written as the wallet writes one.
                let known = main_script(to).is_some_and(|s| s.as_bytes() == script) && main_address(script).as_deref() == Some(to);
                if !known {
                    return Err(malformed(format!("Output {index} withdraws to {to}, which isn't a main-chain (eCash) address this wallet withdraws to.")));
                }
                if output.address != me {
                    return Err(malformed(format!("Output {index} is a withdrawal request held by another address than this wallet's.")));
                }
                dangerous_modes.push(DangerousMode::WithdrawalBurn { output: index });
                Destination::Withdrawal { l1_address: to.clone(), l1_script_pubkey: hex(script), payout: value.to_string(), parent_fee: main_fee.to_string() }
            }
        };
        outputs.push(ViewOutput { index, amount: amount(consumed), destination });
    }
    let fee = total.checked_sub(paid).ok_or_else(|| refuse(RefusalCode::InsufficientFunds, "The spend's coins don't cover what it pays."))?;
    Ok((transaction, SpendView { dangerous_modes, inputs, outputs, fee: amount(fee) }))
}

/// What the unsigned spend `payload` does, for the approval to show: a Clear View, or a refusal.
pub fn decode_spend(payload: &str, starter: &str) -> Result<Decoded, Refusal> {
    let key = CoinKey::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let my_account = crate::own_account(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    Ok(Decoded::Clear { view: read(payload, &key, &my_account)?.1 })
}

/// Signs the unsigned spend `payload`, once it passes every check `decode_spend` makes: one
/// authorization per input, each the Starter's coin key and its signature of the transaction's
/// canonical bytes. The answer is what the node's `submit_transaction` takes.
pub fn sign_spend(payload: &str, starter: &str) -> Result<SignedSpend, Refusal> {
    let key = CoinKey::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let my_account = crate::own_account(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let (transaction, _) = read(payload, &key, &my_account)?;
    let authorization = Authorization { verifying_key: key.key.verifying_key(), signature: key.sign(&transaction.encode())? };
    let authorizations = vec![authorization; transaction.inputs.len()];
    Ok(SignedSpend { tx: authorized_json(&transaction, &authorizations).to_string(), txid: hex(&transaction.txid()) })
}
