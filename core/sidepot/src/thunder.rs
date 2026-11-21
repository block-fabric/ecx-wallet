//! The Sidepot sidechain's own formats (docs/adr/0022): its node is a fork of LayerTwo Labs' Thunder,
//! and these are its `thunder_types`, reimplemented byte for byte. A module here may not use that
//! crate: it draws randomness to sign, and brings a node's dependencies with it.
//!
//! ```text
//! address      first 20 bytes of BLAKE3's XOF over the 32-byte compressed verifying key, in plain
//!              base58 (no version, no checksum)
//! outpoint     0x00 Regular  | txid(32) | vout(u32)
//!              0x01 Coinbase | txid(32) | vout(u32)
//!              0x02 Deposit  | main-chain txid(32, header byte order) | vout(u32)
//! content      0x00 Value      | sats(u64)
//!              0x01 Withdrawal | value(u64) | main_fee(u64) | len(u32) | main-chain script
//!              0x02 GameDeposit | value(u64) | game account key(32)      (docs/adr/0023)
//! output       address(20) | content                  a GameDeposit's address is 20 zero bytes
//! coin         outpoint | output                      a `PointedOutput`: what a server lists
//! transaction  n(u32) | n × (outpoint | BLAKE3(coin)) | m(u32) | m × output
//! ```
//!
//! Integers are little-endian: this is Borsh. A transaction's Utreexo proof isn't in its canonical
//! bytes: the node attaches it when it takes the transaction, so the wallet sends an empty one. The
//! txid is the BLAKE3 of those bytes, and each input is signed over them: a Schnorr signature over
//! ristretto255 as `frost_ristretto255` makes one alone (RFC 9591's ciphersuite), `R(32) | z(32)`,
//! with the challenge `SHA-512("FROST-RISTRETTO255-SHA512-v1" | "chal" | R | key | message)`
//! reduced onto the scalar field.
//!
//! In JSON, as the node's RPC reads and writes them: a txid is hex and a Deposit's outpoint
//! `"<txid as a node prints it>:<vout>"`; an input's hash is a list of 32 numbers; amounts are
//! sats; a withdrawal's main-chain address is text; a game deposit's account is 64 hex digits.
//!
//! `tests/coins.rs` holds every function here to fixtures written by the node's own types
//! (`thunder-vectors/`).
use std::str::FromStr;

use bitcoin::hashes::{sha512, Hash, HashEngine};
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::Identity;
use serde_json::{json, Map, Value};

use crate::entry::unhex;
use crate::hex;

/// A Sidepot sidechain address: the first 20 bytes of BLAKE3's XOF over a verifying key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address(pub [u8; 20]);

impl Address {
    /// The address of no key, 20 zero bytes: what the node requires of a game deposit's output,
    /// which is no coin and has no holder. In base58, `11111111111111111111`.
    pub const ALL_ZEROS: Address = Address([0; 20]);

    /// The address of a verifying key (32 bytes, a compressed ristretto255 point).
    pub fn of_key(verifying_key: &[u8; 32]) -> Self {
        let mut out = [0u8; 20];
        blake3::Hasher::new().update(verifying_key).finalize_xof().fill(&mut out);
        Address(out)
    }

    /// As the node writes it: plain base58, with no version byte and no checksum.
    pub fn base58(&self) -> String {
        bitcoin::base58::encode(&self.0)
    }

    /// An address from that text: base58 of exactly 20 bytes. A mistyped address is still an
    /// address, of nobody's key: nothing in it can tell.
    pub fn parse(text: &str) -> Option<Self> {
        let bytes: [u8; 20] = bitcoin::base58::decode(text).ok()?.try_into().ok()?;
        Some(Address(bytes))
    }
}

/// Which output a coin is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum OutPoint {
    /// An output of a Sidepot transaction.
    Regular { txid: [u8; 32], vout: u32 },
    /// An output of a Sidepot block itself: a fee, or a game cashout.
    Coinbase { txid: [u8; 32], vout: u32 },
    /// A Deposit's output on the main chain; `txid` in header byte order, the reverse of the hex a node prints.
    Deposit { txid: [u8; 32], vout: u32 },
}

impl OutPoint {
    /// Its canonical bytes: 37 of them.
    pub fn encode(&self, out: &mut Vec<u8>) {
        let (tag, txid, vout) = match self {
            OutPoint::Regular { txid, vout } => (0u8, txid, vout),
            OutPoint::Coinbase { txid, vout } => (1, txid, vout),
            OutPoint::Deposit { txid, vout } => (2, txid, vout),
        };
        out.push(tag);
        out.extend_from_slice(txid);
        out.extend_from_slice(&vout.to_le_bytes());
    }

    pub fn to_json(&self) -> Value {
        match self {
            OutPoint::Regular { txid, vout } => json!({ "Regular": { "txid": hex(txid), "vout": vout } }),
            OutPoint::Coinbase { txid, vout } => json!({ "Coinbase": { "txid": hex(txid), "vout": vout } }),
            OutPoint::Deposit { txid, vout } => {
                let mut display = *txid;
                display.reverse();
                json!({ "Deposit": format!("{}:{vout}", hex(&display)) })
            }
        }
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let (kind, body) = only_entry(value).ok_or("an outpoint is one of Regular, Coinbase or Deposit")?;
        let of_transaction = |body: &Value| -> Result<([u8; 32], u32), String> {
            let fields = exact_fields(body, &["txid", "vout"]).ok_or("an outpoint has a txid and a vout")?;
            let txid = fields["txid"].as_str().and_then(unhex::<32>).ok_or("an outpoint's txid is 64 hex digits")?;
            let vout = fields["vout"].as_u64().and_then(|v| u32::try_from(v).ok()).ok_or("an outpoint's vout is a 32-bit number")?;
            Ok((txid, vout))
        };
        match kind {
            "Regular" => of_transaction(body).map(|(txid, vout)| OutPoint::Regular { txid, vout }),
            "Coinbase" => of_transaction(body).map(|(txid, vout)| OutPoint::Coinbase { txid, vout }),
            "Deposit" => {
                let (txid, vout) = body.as_str().and_then(|text| text.split_once(':')).ok_or("a Deposit's outpoint is <txid>:<vout>")?;
                let mut txid = unhex::<32>(txid).ok_or("a Deposit's txid is 64 hex digits")?;
                txid.reverse();
                // As the node's own parser: plain digits, no sign and no leading zero.
                let plain = !vout.is_empty() && vout.bytes().all(|b| b.is_ascii_digit()) && (vout == "0" || !vout.starts_with('0'));
                let vout = plain.then(|| vout.parse::<u32>().ok()).flatten().ok_or("a Deposit's vout is a 32-bit number")?;
                Ok(OutPoint::Deposit { txid, vout })
            }
            other => Err(format!("{other} isn't a kind of outpoint")),
        }
    }
}

/// What an output holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Content {
    /// Sats, spendable by the output's address.
    Value(u64),
    /// A withdrawal request: `value` sats to be paid on the main chain to `main_address`, and
    /// `main_fee` sats for the main chain's miners. It waits for the chain to bundle it.
    Withdrawal {
        value: u64,
        main_fee: u64,
        /// As the node was given it.
        main_address: String,
        /// That address's script: what the canonical bytes carry.
        script: Vec<u8>,
    },
    /// A game deposit (docs/adr/0023): `value` sats leave the coins for the game account `account`
    /// (its 32-byte x-only key), credited when the transaction's block is processed. It never
    /// becomes a coin, and its output's address must be [`Address::ALL_ZEROS`].
    GameDeposit { value: u64, account: [u8; 32] },
}

impl Content {
    /// The sats the output takes from its transaction's inputs: a withdrawal's fee leaves with its payout.
    pub fn consumed(&self) -> Option<u64> {
        match self {
            Content::Value(value) => Some(*value),
            Content::Withdrawal { value, main_fee, .. } => value.checked_add(*main_fee),
            Content::GameDeposit { value, .. } => Some(*value),
        }
    }

    pub fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Content::Value(value) => {
                out.push(0);
                out.extend_from_slice(&value.to_le_bytes());
            }
            Content::Withdrawal { value, main_fee, script, .. } => {
                out.push(1);
                out.extend_from_slice(&value.to_le_bytes());
                out.extend_from_slice(&main_fee.to_le_bytes());
                out.extend_from_slice(&u32::try_from(script.len()).expect("a script is short").to_le_bytes());
                out.extend_from_slice(script);
            }
            Content::GameDeposit { value, account } => {
                out.push(2);
                out.extend_from_slice(&value.to_le_bytes());
                out.extend_from_slice(account);
            }
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Content::Value(value) => json!({ "Value": value }),
            Content::Withdrawal { value, main_fee, main_address, .. } => json!({ "Withdrawal": { "value": value, "main_fee": main_fee, "main_address": main_address } }),
            Content::GameDeposit { value, account } => json!({ "GameDeposit": { "value": value, "account": hex(account) } }),
        }
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let (kind, body) = only_entry(value).ok_or("an output's content is one of Value, Withdrawal or GameDeposit")?;
        match kind {
            "Value" => body.as_u64().map(Content::Value).ok_or_else(|| "a Value is a number of sats".to_string()),
            "Withdrawal" => {
                let fields = exact_fields(body, &["value", "main_fee", "main_address"]).ok_or("a Withdrawal has a value, a main_fee and a main_address")?;
                let value = fields["value"].as_u64().ok_or("a Withdrawal's value is a number of sats")?;
                let main_fee = fields["main_fee"].as_u64().ok_or("a Withdrawal's main_fee is a number of sats")?;
                let main_address = fields["main_address"].as_str().ok_or("a Withdrawal's main_address is text")?;
                let script = node_script(main_address).ok_or_else(|| format!("{main_address} isn't a main-chain address"))?;
                Ok(Content::Withdrawal { value, main_fee, main_address: main_address.to_string(), script })
            }
            "GameDeposit" => {
                let fields = exact_fields(body, &["value", "account"]).ok_or("a GameDeposit has a value and an account")?;
                let value = fields["value"].as_u64().ok_or("a GameDeposit's value is a number of sats")?;
                // The node reads either case and writes lower case: the wallet reads only what the node writes.
                let lower = |text: &&str| !text.bytes().any(|b| b.is_ascii_uppercase());
                let account = fields["account"].as_str().filter(lower).and_then(unhex::<32>).ok_or("a GameDeposit's account is 64 lowercase hex digits")?;
                Ok(Content::GameDeposit { value, account })
            }
            other => Err(format!("{other} isn't a kind of content")),
        }
    }
}

/// The script the node reads from a main-chain address: any network's, as its own parser takes
/// them. The canonical bytes carry the script, so the network's name never reaches a signature.
pub fn node_script(address: &str) -> Option<Vec<u8>> {
    let parsed = bitcoin::Address::<bitcoin::address::NetworkUnchecked>::from_str(address).ok()?;
    Some(parsed.assume_checked().script_pubkey().into_bytes())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub address: Address,
    pub content: Content,
}

impl Output {
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.address.0);
        self.content.encode(out);
    }

    pub fn to_json(&self) -> Value {
        json!({ "address": self.address.base58(), "content": self.content.to_json() })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let fields = exact_fields(value, &["address", "content"]).ok_or("an output has an address and a content")?;
        let address = fields["address"].as_str().and_then(Address::parse).ok_or("an output's address is base58 of 20 bytes")?;
        Ok(Output { address, content: Content::from_json(&fields["content"])? })
    }
}

/// A coin: an output and where it is. What the node's `list_utxos` lists, and what an input commits to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointedOutput {
    pub outpoint: OutPoint,
    pub output: Output,
}

impl PointedOutput {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(96);
        self.outpoint.encode(&mut out);
        self.output.encode(&mut out);
        out
    }

    /// What an input that spends it carries: the BLAKE3 of its canonical bytes.
    pub fn hash(&self) -> [u8; 32] {
        *blake3::hash(&self.encode()).as_bytes()
    }

    pub fn to_json(&self) -> Value {
        json!({ "outpoint": self.outpoint.to_json(), "output": self.output.to_json() })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let fields = exact_fields(value, &["outpoint", "output"]).ok_or("a coin has an outpoint and an output")?;
        Ok(PointedOutput { outpoint: OutPoint::from_json(&fields["outpoint"])?, output: Output::from_json(&fields["output"])? })
    }
}

/// A Sidepot transaction, without its Utreexo proof: the node attaches that.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Transaction {
    /// Each coin spent, with the hash of the coin itself.
    pub inputs: Vec<(OutPoint, [u8; 32])>,
    pub outputs: Vec<Output>,
}

impl Transaction {
    /// The canonical bytes: what the txid hashes and every input's signature covers.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&u32::try_from(self.inputs.len()).expect("few inputs").to_le_bytes());
        for (outpoint, hash) in &self.inputs {
            outpoint.encode(&mut out);
            out.extend_from_slice(hash);
        }
        out.extend_from_slice(&u32::try_from(self.outputs.len()).expect("few outputs").to_le_bytes());
        for output in &self.outputs {
            output.encode(&mut out);
        }
        out
    }

    pub fn txid(&self) -> [u8; 32] {
        *blake3::hash(&self.encode()).as_bytes()
    }

    /// As the node's `submit_transaction` takes it, with an empty proof for the node to fill.
    pub fn to_json(&self) -> Value {
        let inputs: Vec<Value> = self.inputs.iter().map(|(outpoint, hash)| json!([outpoint.to_json(), hash.to_vec()])).collect();
        let outputs: Vec<Value> = self.outputs.iter().map(Output::to_json).collect();
        json!({ "inputs": inputs, "proof": { "targets": [], "hashes": [] }, "outputs": outputs })
    }

    /// Reads one back. Only with an empty proof: the wallet never has another.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let fields = exact_fields(value, &["inputs", "proof", "outputs"]).ok_or("a transaction has inputs, a proof and outputs")?;
        let proof = exact_fields(&fields["proof"], &["targets", "hashes"]).ok_or("a proof has targets and hashes")?;
        if !["targets", "hashes"].iter().all(|f| proof[*f].as_array().is_some_and(Vec::is_empty)) {
            return Err("the wallet reads only a transaction whose proof is empty".into());
        }
        let mut inputs = vec![];
        for input in fields["inputs"].as_array().ok_or("a transaction's inputs are a list")? {
            let [outpoint, hash] = input.as_array().map(Vec::as_slice).unwrap_or_default() else {
                return Err("an input is an outpoint and its coin's hash".into());
            };
            let bytes: Option<Vec<u8>> = hash.as_array().and_then(|h| h.iter().map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok())).collect());
            let hash: [u8; 32] = bytes.and_then(|b| b.try_into().ok()).ok_or("an input's hash is 32 bytes")?;
            inputs.push((OutPoint::from_json(outpoint)?, hash));
        }
        let outputs = fields["outputs"].as_array().ok_or("a transaction's outputs are a list")?.iter().map(Output::from_json).collect::<Result<_, _>>()?;
        Ok(Transaction { inputs, outputs })
    }
}

/// One input's authorization: the key its coin's address is of, and that key's signature of the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Authorization {
    pub verifying_key: [u8; 32],
    pub signature: [u8; 64],
}

impl Authorization {
    pub fn to_json(&self) -> Value {
        json!({ "verifying_key": hex(&self.verifying_key), "signature": hex(&self.signature) })
    }

    pub fn from_json(value: &Value) -> Result<Self, String> {
        let fields = exact_fields(value, &["verifying_key", "signature"]).ok_or("an authorization has a verifying_key and a signature")?;
        let verifying_key = fields["verifying_key"].as_str().and_then(unhex::<32>).ok_or("a verifying key is 64 hex digits")?;
        let signature = fields["signature"].as_str().and_then(unhex::<64>).ok_or("a signature is 128 hex digits")?;
        Ok(Authorization { verifying_key, signature })
    }
}

/// The node's `Authorized<Transaction>`, as `submit_transaction` takes it: one authorization per input, in order.
pub fn authorized_json(transaction: &Transaction, authorizations: &[Authorization]) -> Value {
    json!({ "transaction": transaction.to_json(), "authorizations": authorizations.iter().map(Authorization::to_json).collect::<Vec<_>>() })
}

/// Reads an `Authorized<Transaction>` back.
pub fn authorized_from_json(value: &Value) -> Result<(Transaction, Vec<Authorization>), String> {
    let fields = exact_fields(value, &["transaction", "authorizations"]).ok_or("a signed transaction has a transaction and authorizations")?;
    let authorizations = fields["authorizations"].as_array().ok_or("authorizations are a list")?.iter().map(Authorization::from_json).collect::<Result<_, _>>()?;
    Ok((Transaction::from_json(&fields["transaction"])?, authorizations))
}

/// A signing key: a nonzero scalar of ristretto255's field, as `frost_ristretto255::SigningKey` is.
#[derive(Clone)]
pub struct SigningKey {
    scalar: Scalar,
    verifying_key: [u8; 32],
}

/// What the challenge hash starts with: RFC 9591's FROST(ristretto255, SHA-512), then its H2's label.
const CHALLENGE_PREFIX: &[u8] = b"FROST-RISTRETTO255-SHA512-v1chal";

impl SigningKey {
    /// The key of `scalar`. None for zero, which is no key.
    pub fn from_scalar(scalar: Scalar) -> Option<Self> {
        if scalar == Scalar::ZERO {
            return None;
        }
        Some(SigningKey { scalar, verifying_key: RistrettoPoint::mul_base(&scalar).compress().to_bytes() })
    }

    /// The key from its 32 canonical bytes, as the node's `SigningKey::deserialize` reads one.
    pub fn from_bytes(bytes: &[u8; 32]) -> Option<Self> {
        Self::from_scalar(Option::from(Scalar::from_canonical_bytes(*bytes))?)
    }

    /// 32 bytes: the compressed point `scalar × B`.
    pub fn verifying_key(&self) -> [u8; 32] {
        self.verifying_key
    }

    pub fn address(&self) -> Address {
        Address::of_key(&self.verifying_key)
    }

    /// Signs `message` with the nonce scalar `nonce`, which must be secret, nonzero and never used
    /// for another message: `R = nonce × B`, `z = nonce + challenge × key`. None for a zero nonce.
    pub fn sign_with_nonce(&self, nonce: &Scalar, message: &[u8]) -> Option<[u8; 64]> {
        if *nonce == Scalar::ZERO {
            return None;
        }
        let r = RistrettoPoint::mul_base(nonce).compress().to_bytes();
        let z = nonce + challenge(&r, &self.verifying_key, message) * self.scalar;
        let mut signature = [0u8; 64];
        signature[..32].copy_from_slice(&r);
        signature[32..].copy_from_slice(z.as_bytes());
        Some(signature)
    }
}

/// The Schnorr challenge: SHA-512 over the prefix, `R`, the verifying key and the message, reduced onto the scalar field.
fn challenge(r: &[u8; 32], verifying_key: &[u8; 32], message: &[u8]) -> Scalar {
    let mut engine = sha512::Hash::engine();
    engine.input(CHALLENGE_PREFIX);
    engine.input(r);
    engine.input(verifying_key);
    engine.input(message);
    Scalar::from_bytes_mod_order_wide(&sha512::Hash::from_engine(engine).to_byte_array())
}

/// True if `signature` is `verifying_key`'s of `message`, as the node checks one: `z × B = R + challenge × key`.
pub fn verify(verifying_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let (r, z): ([u8; 32], [u8; 32]) = (signature[..32].try_into().expect("32 bytes"), signature[32..].try_into().expect("32 bytes"));
    let point = |bytes: &[u8; 32]| CompressedRistretto(*bytes).decompress().filter(|p| *p != RistrettoPoint::identity());
    let (Some(key), Some(r_point), Some(z)) = (point(verifying_key), point(&r), Option::<Scalar>::from(Scalar::from_canonical_bytes(z))) else {
        return false;
    };
    RistrettoPoint::mul_base(&z) == r_point + challenge(&r, verifying_key, message) * key
}

/// The object's one key and its value, if it has exactly one.
fn only_entry(value: &Value) -> Option<(&str, &Value)> {
    let object = value.as_object()?;
    let (key, body) = object.iter().next()?;
    (object.len() == 1).then_some((key.as_str(), body))
}

/// The object, if its keys are exactly `fields`.
fn exact_fields<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == fields.len() && fields.iter().all(|f| object.contains_key(*f))).then_some(object)
}
