//! The Sidepot Chain Module (Slot 88, docs/adr/0021). Sidepot is a game whose state is a function of
//! eCash's own blocks: a BIP300 Deposit to the Slot fills a game account, and the account's moves
//! are signed entries carried in `OP_RETURN` outputs of ordinary eCash transactions. So the game
//! gives this module no transactions to decode or sign:
//!
//! - [`declare`] reports the binding the module serves;
//! - [`derive_account`] turns the Slot's Starter into the game account, `spot:<x-only key>`;
//! - [`deposit_destination`] says what a Deposit from eCash is credited to: that account;
//! - [`parse_entry`] reads a `sidepot:` action link, without the Starter, so the wallet can refuse
//!   a bad one before asking the user to unlock;
//! - [`sign_entry`] makes the link's entry, signed by the game account for this network's Sidepot,
//!   with what it says, read back from its own bytes, for the approval to show.
//!
//! The eCash transaction that carries an entry is the L1 module's (`build_data`), paid from the
//! wallet's eCash coins.
//!
//! The Sidepot sidechain also has ordinary coins, held by addresses of its own: a cashout arrives
//! as one, and a coin can ask to be withdrawn to the main chain (docs/adr/0022). Those do have
//! transactions, in the sidechain node's own format. They are the wallet's own, built here from
//! what the user asks, never a Signing Request someone else sends:
//!
//! - [`coin_address`] turns the Slot's Starter into the wallet's Sidepot address, on a path of its own;
//! - [`build_spend`], [`decode_spend`] and [`sign_spend`] build a transfer, a withdrawal request
//!   or a move into the game account (docs/adr/0023) from that address's coins, say what it does,
//!   and sign it (`coins.rs`, `thunder.rs`).
//!
//! This module holds nothing between calls and receives only its own Slot's Starter. Every
//! per-network value comes from Sidepot's Chain Entry (`chain-entry.json`).
use std::str::FromStr;

use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::{All, Keypair, Secp256k1};
use bitcoin::NetworkKind;
use serde::Serialize;

pub mod chain_entry;
pub mod coins;
pub mod entry;
mod link;
pub mod thunder;

pub use chain_entry::{chain_entry, check_chain_entry, AddressParams, ChainEntry, NetworkEntry, ServerApi, SidechainServerEntry, SidepotParams};
pub use coins::{build_spend, coin_address, decode_spend, sign_spend, BuiltSpend, CoinAddress, SignedSpend, COIN_PATH};
pub use entry::{anchor_bytes, Action, DecodeError, Domain, Entry, BUY_LEN, CASHOUT_LEN, MAX_KEYS};
pub use link::{parse_action, Request, MAX_LINK_BYTES};

/// The network this build serves, its key in the Chain Entry: `$ECX_NETWORK` at build time (build.rs).
pub const NETWORK: &str = env!("ECX_NETWORK");

/// Where the game account's key sits under the Starter's BIP39 seed (no passphrase): purpose 300
/// (BIP300), then the Slot Sidepot proposed itself for, 88, then account 0, all hardened. The key
/// at that node is the account's, used as a BIP340 key as it is: no tweak, and nothing derived
/// below it. The path is the same on every network; the Starter already differs by Slot.
pub const ACCOUNT_PATH: &str = "300h/88h/0h";

/// What a game account is written as, before its x-only key in lowercase hex: a Deposit's
/// destination, and the account's address wherever the wallet shows one.
pub const ACCOUNT_PREFIX: &str = "spot:";

/// The smallest Deposit the wallet makes, in sats. The game credits any amount, so this is the
/// wallet's own floor: a Deposit below it would be worth less than the fees to make it and cash it out.
const MINIMUM_DEPOSIT: u64 = 1_000;

/// Why the module won't read a link or make an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalCode {
    /// A request this module has no way to serve: Sidepot has no transactions of its own to decode or sign.
    Malformed,
    /// The key handed in isn't a Starter (a wallet bug, not the requester's).
    InvalidStarter,
    /// A link that isn't one of Sidepot's, or that asks for an entry the game would never take.
    InvalidAction,
    /// A Sidepot action the wallet doesn't make.
    UnsupportedAction,
    /// A coin spend with an input that isn't the Starter's: there is nothing of it to sign.
    NothingToSign,
    /// `build_spend`: the address's coins don't cover the payment and the fee.
    InsufficientFunds,
    /// `build_spend`: a withdrawal paying less than the main chain relays.
    Dust,
}

pub(crate) fn refuse(code: RefusalCode, message: impl Into<String>) -> Refusal {
    Refusal { code, message: message.into() }
}

/// What the module serves: requests for this chain, in this format.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    /// CAIP-2, e.g. `ecash:mainnet-s88`.
    pub chain: String,
    /// `sidepot-entry`: no Signing Request has it. Entries are made from action links only.
    pub format: String,
    /// The entry versions the module writes: the spec's version byte, 0.
    pub payload_versions: Vec<String>,
}

/// `declare()`'s answer: the binding plus optional capabilities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub binding: Binding,
    pub capabilities: Vec<String>,
}

/// `entries`: the module makes signed entries from action links, for the L1 module to carry
/// (docs/adr/0021). `depositDestination` only once the Chain Entry pins the Slot's activation
/// (docs/adr/0004), as Flush: a Deposit to an inactive Slot is anyone's. `coins`: the module has an
/// address on the Sidepot sidechain, and builds and signs its coins' spends (docs/adr/0022).
pub fn declare() -> Declaration {
    let mut capabilities = vec!["entries".to_string()];
    if network().activation.is_some() {
        capabilities.push("depositDestination".into());
    }
    capabilities.push("coins".into());
    Declaration { binding: Binding { chain: network().chain.clone(), format: "sidepot-entry".into(), payload_versions: vec!["0".into()] }, capabilities }
}

/// This build's network in Sidepot's Chain Entry.
pub fn network() -> &'static NetworkEntry {
    &chain_entry().networks[NETWORK]
}

/// The Sidepot this build's entries are for: the network's anchor block and Slot.
pub fn domain() -> Domain {
    let network = network();
    Domain {
        anchor: anchor_bytes(&network.params.anchor.hash).expect("checked with the Chain Entry"),
        slot: network.slot.and_then(|slot| u8::try_from(slot).ok()).expect("checked with the Chain Entry"),
    }
}

/// The game account, in the shape every Chain Module's account has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Watch data: the account itself, `spot:<x-only key>`. There is nothing else to watch.
    pub descriptor: String,
    /// The one account, at index 0, if any was asked for.
    pub receive: Vec<AddressEntry>,
    /// Always empty: an account has no change.
    pub change: Vec<AddressEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressEntry {
    pub index: u32,
    /// `spot:<x-only key>`: what a Deposit's destination names.
    pub address: String,
    /// Always empty: an account is no script. It is a balance in the game's state.
    pub script_pubkey: String,
    /// The account's key: 32 bytes, x-only (BIP340), lowercase hex. Not the 33-byte compressed key
    /// other chains' addresses carry: Sidepot names a player by this key everywhere.
    pub public_key: String,
}

/// The Starter → its game account. There is one, however many addresses are asked for, and no change.
pub fn derive_account(starter: &str, receive_count: u32, _change_count: u32) -> Result<Account, String> {
    let player = hex(&AccountKey::new(starter)?.player());
    let address = format!("{ACCOUNT_PREFIX}{player}");
    let receive = if receive_count == 0 { vec![] } else { vec![AddressEntry { index: 0, address: address.clone(), script_pubkey: String::new(), public_key: player }] };
    Ok(Account { descriptor: address, receive, change: vec![] })
}

/// The Starter's game account key.
struct AccountKey {
    keypair: Keypair,
    secp: Secp256k1<All>,
}

impl AccountKey {
    /// The Starter (a 12-word BIP39 mnemonic) → its BIP39 seed with no passphrase → the key at
    /// `m/300'/88'/0'`. Anything else (the L1 Account Key, another phrase) is refused.
    fn new(starter: &str) -> Result<Self, String> {
        let mnemonic = bip39::Mnemonic::parse_in(bip39::Language::English, starter).map_err(|e| format!("invalid Starter: {e}"))?;
        let secp = Secp256k1::new();
        let master = Xpriv::new_master(NetworkKind::Main, &mnemonic.to_seed("")).map_err(|e| format!("invalid Starter: {e}"))?;
        let path = DerivationPath::from_str(&format!("m/{ACCOUNT_PATH}")).expect("valid path");
        let key = master.derive_priv(&secp, &path).map_err(|e| e.to_string())?.private_key;
        Ok(AccountKey { keypair: Keypair::from_secret_key(&secp, &key), secp })
    }

    /// The account's x-only key: the player.
    fn player(&self) -> [u8; 32] {
        self.keypair.x_only_public_key().0.serialize()
    }
}

/// The Starter's game account key, for the module's own checks (where a move of coins into the game goes).
pub(crate) fn own_account(starter: &str) -> Result<[u8; 32], String> {
    Ok(AccountKey::new(starter)?.player())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepositDestination {
    /// The game account the Deposit is credited to, `spot:<x-only key>`.
    pub address: String,
    /// The bytes the M5's `OP_RETURN` pushes, hex: `address` in ASCII (69 bytes).
    pub destination: String,
    /// The asset the credit arrives in: "", Sidepot's ECX.
    pub asset: String,
    /// Sats, as a decimal string: the smallest Deposit the wallet builds.
    pub minimum: String,
}

/// What a Deposit to Sidepot's Slot is credited to: the Starter's game account. The game reads a
/// Deposit whose address is `spot:<64 lowercase hex digits of an x-only key>` as that account's;
/// any other address gets an ordinary coin on the sidechain (`deposit_player` in the reference).
pub fn deposit_destination(starter: &str) -> Result<DepositDestination, String> {
    if network().activation.is_none() {
        return Err("Sidepot's Chain Entry pins no activation block: this wallet makes no Deposit to it (docs/adr/0004).".into());
    }
    let address = derive_account(starter, 1, 0)?.descriptor;
    Ok(DepositDestination { destination: hex(address.as_bytes()), address, asset: String::new(), minimum: MINIMUM_DEPOSIT.to_string() })
}

/// What an entry does, for the approval to show. Sats are decimal strings (they may pass 2^53).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EntryAction {
    /// Buy `keys` keys in round `round`, each at no more than `max_price` sats: at most `max_total` in all.
    Buy { round: u32, keys: u16, max_price: String, max_total: String },
    /// Pay `amount` sats of the game balance ("0": all of it) to the Sidepot sidechain address `dest`
    /// (40 hex digits), which is `dest_address` as that chain writes addresses (base58).
    Cashout { amount: String, dest: String, dest_address: String },
}

/// An entry as the user reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    #[serde(flatten)]
    pub action: EntryAction,
    /// The game account that makes it, as an address: `spot:<x-only key>`. Absent before it is signed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub player: Option<String>,
    /// A cashout's: whether its destination is the Starter's own Sidepot address (docs/adr/0022).
    /// Absent for a buy, and before the entry is signed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_yours: Option<bool>,
    /// The account's entry counter, as a decimal string.
    pub nonce: String,
    /// The last tick of the game clock at which the entry counts: after it, it lapses.
    pub expires: u32,
    /// The Slot the entry is signed for.
    pub slot: u8,
    /// The anchor block the entry is signed for, as a node prints its hash.
    pub anchor: String,
}

/// `sign_entry`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedEntry {
    /// The entry, hex: 128 bytes (a buy) or 142 (a cashout). The data of one `OP_RETURN` output.
    pub entry: String,
    /// What those bytes say, read back from them.
    pub view: EntryView,
}

/// `mine`: the Starter's own Sidepot address, once there is a Starter to derive it from.
fn view(action: Action, player: Option<[u8; 32]>, mine: Option<thunder::Address>, nonce: u64, expires: u32) -> EntryView {
    let dest_yours = match action {
        Action::Cashout { dest, .. } => mine.map(|mine| mine.0 == dest),
        Action::Buy { .. } => None,
    };
    let action = match action {
        Action::Buy { round, keys, max_price } => {
            EntryAction::Buy { round, keys, max_price: max_price.to_string(), max_total: (u128::from(max_price) * u128::from(keys)).to_string() }
        }
        Action::Cashout { amount, dest } => EntryAction::Cashout { amount: amount.to_string(), dest: hex(&dest), dest_address: thunder::Address(dest).base58() },
    };
    let network = network();
    EntryView {
        action,
        player: player.map(|p| format!("{ACCOUNT_PREFIX}{}", hex(&p))),
        dest_yours,
        nonce: nonce.to_string(),
        expires,
        slot: domain().slot,
        anchor: network.params.anchor.hash.to_lowercase(),
    }
}

/// What `link` asks for, without the Starter: the wallet refuses a bad link before any unlock prompt.
pub fn parse_entry(link: &str) -> Result<EntryView, Refusal> {
    let Request { action, nonce, expires } = parse_action(link)?;
    Ok(view(action, None, None, nonce, expires))
}

/// The entry `link` asks for, signed by the Starter's game account for this network's Sidepot.
/// The view is read back from the signed bytes, whose signature is checked: what the approval shows
/// is what the transaction will carry.
pub fn sign_entry(link: &str, starter: &str) -> Result<SignedEntry, Refusal> {
    let Request { action, nonce, expires } = parse_action(link)?;
    let key = AccountKey::new(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    let domain = domain();
    let bytes = Entry::sign(&key.secp, &key.keypair, &domain, action, nonce, expires).encode();
    let read = Entry::decode(&bytes).ok().filter(|entry| entry.verify(&key.secp, &domain) && entry.player == key.player());
    let entry = read.ok_or_else(|| refuse(RefusalCode::Malformed, "The entry the wallet made doesn't read back as signed by its account."))?;
    // A cashout pays a Sidepot address: the view says whether it is this Starter's own.
    let mine = coins::own_address(starter).map_err(|e| refuse(RefusalCode::InvalidStarter, e))?;
    Ok(SignedEntry { entry: hex(&bytes), view: view(entry.action, Some(entry.player), Some(mine), entry.nonce, entry.expires) })
}

/// Sidepot has no Signing Requests: nothing to check, decode, sign or finalize. Its entries are
/// made from action links (`sendAction`), never from a payload someone else built.
pub fn no_signing_requests() -> Refusal {
    refuse(RefusalCode::Malformed, "Sidepot signs no transactions: its entries are made from sidepot: action links, through sendAction.")
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
