//! Sidepot's action links (docs/adr/0021): what a Sidechain App hands `sendAction` on Slot 88.
//!
//! ```text
//! sidepot:buy?round=<u32>&keys=<1..1000>&max_price=<sats>&nonce=<u64>&expires=<u32>
//! sidepot:cashout?amount=<sats, 0 = all>&dest=<40 hex>&nonce=<u64>&expires=<u32>
//! ```
//!
//! Read strictly: the scheme and verb in lowercase, each parameter exactly once in any order and no
//! other, numbers in plain decimal digits (no sign, no leading zero, no `%XX`), `dest` 40 hex digits
//! of either case. The site supplies the round, the price limit, the nonce and the expiry, which
//! only the game's state gives; the wallet signs what the link says and shows every field of it.
use crate::entry::{unhex, Action, MAX_KEYS};
use crate::{refuse, Refusal, RefusalCode};

/// A link longer than this is refused.
pub const MAX_LINK_BYTES: usize = 512;

/// An action a link asks for, not yet signed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Request {
    pub action: Action,
    pub nonce: u64,
    pub expires: u32,
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse(RefusalCode::InvalidAction, message)
}

/// A number in plain decimal digits that fits `T`.
fn number<T: std::str::FromStr>(name: &str, value: &str) -> Result<T, Refusal> {
    let plain = !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) && (value == "0" || !value.starts_with('0'));
    plain.then(|| value.parse().ok()).flatten().ok_or_else(|| invalid(format!("The link's {name} isn't a number it can be: {value:?}.")))
}

/// Reads `link`, a `sidepot:` action link.
pub fn parse_action(link: &str) -> Result<Request, Refusal> {
    const FORM: &str = "Not an action link of Sidepot (sidepot:buy?… or sidepot:cashout?…).";
    if link.len() > MAX_LINK_BYTES {
        return Err(invalid(format!("The link is too long ({} bytes; at most {MAX_LINK_BYTES}).", link.len())));
    }
    let rest = link.strip_prefix("sidepot:").ok_or_else(|| invalid(FORM))?;
    let (verb, query) = rest.split_once('?').ok_or_else(|| invalid(FORM))?;
    let names: &[&str] = match verb {
        "buy" => &["round", "keys", "max_price", "nonce", "expires"],
        "cashout" => &["amount", "dest", "nonce", "expires"],
        _ if !verb.is_empty() && verb.bytes().all(|b| b.is_ascii_lowercase()) => {
            return Err(refuse(RefusalCode::UnsupportedAction, format!("This wallet doesn't make Sidepot's \"{verb}\" action: only buy and cashout.")))
        }
        _ => return Err(invalid(FORM)),
    };
    let mut values: Vec<Option<&str>> = vec![None; names.len()];
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').ok_or_else(|| invalid(format!("The link has a parameter without a value: {pair:?}.")))?;
        let at = names.iter().position(|n| *n == name).ok_or_else(|| invalid(format!("A Sidepot {verb} link has no parameter {name:?}.")))?;
        if values[at].replace(value).is_some() {
            return Err(invalid(format!("The link gives {name} twice.")));
        }
    }
    let get = |name: &str| {
        let at = names.iter().position(|n| *n == name).expect("a parameter of this verb");
        values[at].ok_or_else(|| invalid(format!("The link gives no {name}.")))
    };
    let action = if verb == "buy" {
        let keys: u16 = number("keys", get("keys")?)?;
        if keys == 0 || keys > MAX_KEYS {
            return Err(invalid(format!("One entry buys 1 to {MAX_KEYS} keys, not {keys}.")));
        }
        Action::Buy { round: number("round", get("round")?)?, keys, max_price: number("max_price", get("max_price")?)? }
    } else {
        let dest = get("dest")?;
        let dest = unhex::<20>(dest).ok_or_else(|| invalid(format!("The link's dest isn't a Sidepot address (40 hex digits): {dest:?}.")))?;
        Action::Cashout { amount: number("amount", get("amount")?)?, dest }
    };
    Ok(Request { action, nonce: number("nonce", get("nonce")?)?, expires: number("expires", get("expires")?)? })
}
