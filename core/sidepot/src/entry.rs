//! Sidepot's entries (the spec's section 3, v0.8): one signed instruction, carried in an `OP_RETURN`
//! output of an eCash transaction. A reimplementation of the reference `sidepot-core` `entry.rs`,
//! byte for byte, without its ambient randomness and global secp context, which a module here may
//! not have.
//!
//! ```text
//! magic "SPOT"(4) | version 0x00 | kind(1) | body | player(32) | nonce(u64) | expires(u32) | sig(64)
//! kind 0x01 BUY     (128 bytes): body = round(u32) | keys(u16, 1..1000) | max_price(u64 sats)
//! kind 0x02 CASHOUT (142 bytes): body = amount(u64 sats, 0 = all) | dest(20 bytes)
//! ```
//!
//! Integers are little-endian. `sig` is BIP340 by `player` over
//! `tagged_hash("Sidepot/entry", anchor(32) | slot(1) | every byte before sig)`: the [`Domain`] is
//! signed but not sent, so an entry counts only in the Sidepot it was made for.
use bitcoin::hashes::{sha256, Hash, HashEngine};
use bitcoin::secp256k1::schnorr::Signature;
use bitcoin::secp256k1::{Keypair, Message, Secp256k1, Signing, Verification, XOnlyPublicKey};

pub const MAGIC: [u8; 4] = *b"SPOT";
pub const VERSION: u8 = 0x00;
pub const KIND_BUY: u8 = 0x01;
pub const KIND_CASHOUT: u8 = 0x02;
/// magic(4) version(1) kind(1)
const HEADER: usize = 6;
/// round(4) keys(2) max_price(8)
const BUY_BODY: usize = 14;
/// amount(8) dest(20)
const CASHOUT_BODY: usize = 28;
const SIG: usize = 64;
/// player(32) nonce(8) expires(4) sig(64)
const TAIL: usize = 32 + 8 + 4 + SIG;
pub const BUY_LEN: usize = HEADER + BUY_BODY + TAIL;
pub const CASHOUT_LEN: usize = HEADER + CASHOUT_BODY + TAIL;
const TAG: &[u8] = b"Sidepot/entry";
/// The most keys one BUY asks for (the spec's limit; the game ignores an entry asking for more, or none).
pub const MAX_KEYS: u16 = 1000;

/// Which Sidepot an entry is for: every signature commits to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Domain {
    /// The hash of the eCash block that mined the Slot's proposal, in header (internal) byte order:
    /// the reverse of the hex a node prints.
    pub anchor: [u8; 32],
    /// The BIP300 Slot.
    pub slot: u8,
}

/// A block hash as a node prints it (64 hex digits) → its bytes in header order. None for anything else.
pub fn anchor_bytes(display_hex: &str) -> Option<[u8; 32]> {
    let mut bytes = unhex::<32>(display_hex)?;
    bytes.reverse();
    Some(bytes)
}

/// `N` bytes from exactly `2N` hex digits of either case.
pub(crate) fn unhex<const N: usize>(hex: &str) -> Option<[u8; N]> {
    if hex.len() != 2 * N || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Buy `keys` keys in `round`, at no more than `max_price` sats each.
    Buy { round: u32, keys: u16, max_price: u64 },
    /// Pay `amount` sats of the game balance (0: all of it) to the Sidepot sidechain address `dest`.
    Cashout { amount: u64, dest: [u8; 20] },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub action: Action,
    /// The BIP340 x-only key of the player's game account.
    pub player: [u8; 32],
    pub nonce: u64,
    /// The last tick of the game clock at which the entry counts.
    pub expires: u32,
    pub sig: [u8; 64],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    Length(usize),
    Magic,
    Version(u8),
    Kind(u8),
}

impl Entry {
    pub fn decode(data: &[u8]) -> Result<Self, DecodeError> {
        if data.len() < HEADER {
            return Err(DecodeError::Length(data.len()));
        }
        if data[0..4] != MAGIC {
            return Err(DecodeError::Magic);
        }
        if data[4] != VERSION {
            return Err(DecodeError::Version(data[4]));
        }
        let len = match data[5] {
            KIND_BUY => BUY_LEN,
            KIND_CASHOUT => CASHOUT_LEN,
            kind => return Err(DecodeError::Kind(kind)),
        };
        if data.len() != len {
            return Err(DecodeError::Length(data.len()));
        }
        let b = &data[HEADER..len - TAIL];
        let action = match data[5] {
            KIND_BUY => Action::Buy {
                round: u32::from_le_bytes(b[0..4].try_into().unwrap()),
                keys: u16::from_le_bytes(b[4..6].try_into().unwrap()),
                max_price: u64::from_le_bytes(b[6..14].try_into().unwrap()),
            },
            _ => Action::Cashout { amount: u64::from_le_bytes(b[0..8].try_into().unwrap()), dest: b[8..28].try_into().unwrap() },
        };
        let t = &data[len - TAIL..];
        Ok(Entry {
            action,
            player: t[0..32].try_into().unwrap(),
            nonce: u64::from_le_bytes(t[32..40].try_into().unwrap()),
            expires: u32::from_le_bytes(t[40..44].try_into().unwrap()),
            sig: t[44..108].try_into().unwrap(),
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(CASHOUT_LEN);
        out.extend_from_slice(&MAGIC);
        out.push(VERSION);
        match self.action {
            Action::Buy { round, keys, max_price } => {
                out.push(KIND_BUY);
                out.extend_from_slice(&round.to_le_bytes());
                out.extend_from_slice(&keys.to_le_bytes());
                out.extend_from_slice(&max_price.to_le_bytes());
            }
            Action::Cashout { amount, dest } => {
                out.push(KIND_CASHOUT);
                out.extend_from_slice(&amount.to_le_bytes());
                out.extend_from_slice(&dest);
            }
        }
        out.extend_from_slice(&self.player);
        out.extend_from_slice(&self.nonce.to_le_bytes());
        out.extend_from_slice(&self.expires.to_le_bytes());
        out.extend_from_slice(&self.sig);
        out
    }

    /// What the player signs: tagged_hash("Sidepot/entry", anchor | slot | every byte before the signature).
    pub fn sighash(&self, domain: &Domain) -> [u8; 32] {
        let bytes = self.encode();
        tagged_hash(TAG, &[&domain.anchor[..], &[domain.slot], &bytes[..bytes.len() - SIG]])
    }

    /// True if `sig` is `player`'s BIP340 signature of this entry for `domain`.
    pub fn verify<C: Verification>(&self, secp: &Secp256k1<C>, domain: &Domain) -> bool {
        let (Ok(player), Ok(sig)) = (XOnlyPublicKey::from_slice(&self.player), Signature::from_slice(&self.sig)) else {
            return false;
        };
        secp.verify_schnorr(&sig, &Message::from_digest(self.sighash(domain)), &player).is_ok()
    }

    /// The entry `keypair`'s game account makes of `action` for `domain`, signed. BIP340 without
    /// auxiliary randomness: the module has no source of it, and the signature is as valid.
    pub fn sign<C: Signing>(secp: &Secp256k1<C>, keypair: &Keypair, domain: &Domain, action: Action, nonce: u64, expires: u32) -> Self {
        let player = keypair.x_only_public_key().0.serialize();
        let mut entry = Entry { action, player, nonce, expires, sig: [0; 64] };
        entry.sig = secp.sign_schnorr_no_aux_rand(&Message::from_digest(entry.sighash(domain)), keypair).serialize();
        entry
    }
}

/// BIP340's tagged hash: SHA256(SHA256(tag) | SHA256(tag) | msg), `msg` given in parts.
pub fn tagged_hash(tag: &[u8], msg: &[&[u8]]) -> [u8; 32] {
    let tag_hash = sha256::Hash::hash(tag).to_byte_array();
    let mut engine = sha256::Hash::engine();
    engine.input(&tag_hash);
    engine.input(&tag_hash);
    for part in msg {
        engine.input(part);
    }
    sha256::Hash::from_engine(engine).to_byte_array()
}
