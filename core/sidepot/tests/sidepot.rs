//! The Sidepot Chain Module against the spec (https://sidepot.cash/rules, v0.8) and its reference
//! implementation (`sidepot-core`, `sidepot-cli`): the game account, the entry's bytes and
//! signature, and the action links. Every fixture is of mainnet, whose Sidepot is Slot 88 anchored
//! at block 982,723.
use bitcoin::hashes::{sha256, Hash};
use bitcoin::secp256k1::schnorr::Signature;
use bitcoin::secp256k1::{Keypair, Message, Secp256k1, SecretKey, XOnlyPublicKey};
use ecx_sidepot::entry::tagged_hash;
use ecx_sidepot::{
    anchor_bytes, chain_entry, check_chain_entry, coin_address, declare, deposit_destination, derive_account, domain, network, parse_action, parse_entry, sign_entry, Action,
    DecodeError, Domain, Entry, EntryAction, RefusalCode, ServerApi, BUY_LEN, CASHOUT_LEN,
};

const STARTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/// Mainnet's block 982,723, which mined Slot 88's proposal, as a node prints it.
const MAINNET_ANCHOR: &str = "0000000000000000019340956c9c00140207ee2ad5c683894a51bbe072bbbf33";
/// A block of another chain (Bitcoin's block 1): what another Sidepot's anchor would be.
const OTHER_ANCHOR: &str = "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048";

const BUY: &str = "sidepot:buy?round=7&keys=3&max_price=150000&nonce=42&expires=5000";
const CASHOUT: &str = "sidepot:cashout?amount=250000&dest=00112233445566778899aabbccddeeff00112233&nonce=43&expires=5001";

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The entry `link` makes for STARTER, and its bytes.
fn signed(link: &str) -> (Entry, Vec<u8>) {
    let bytes = unhex(&sign_entry(link, STARTER).unwrap().entry);
    (Entry::decode(&bytes).unwrap(), bytes)
}

fn player() -> String {
    derive_account(STARTER, 1, 0).unwrap().receive[0].public_key.clone()
}

#[test]
fn declare_reports_the_mainnet_slot_88_binding_and_its_capabilities() {
    let d = declare();
    assert_eq!(d.binding.chain, "ecash:mainnet-s88");
    assert_eq!(d.binding.format, "sidepot-entry");
    assert_eq!(d.capabilities, ["entries", "depositDestination", "coins"]);
}

#[test]
fn the_chain_entry_puts_sidepot_at_slot_88_under_ecash_anchored_at_its_proposals_block() {
    assert_eq!(chain_entry().name, "Sidepot");
    let mainnet = network();
    assert_eq!((mainnet.chain.as_str(), mainnet.slot, mainnet.parent.as_deref()), ("ecash:mainnet-s88", Some(88), Some("ecash:mainnet")));
    assert_eq!((mainnet.params.anchor.height, mainnet.params.anchor.hash.as_str()), (982_723, MAINNET_ANCHOR));
    assert_eq!(mainnet.identity_block, mainnet.params.anchor);
    let activation = mainnet.activation.as_ref().expect("pinned");
    assert_eq!((activation.height, activation.hash.as_str()), (984_540, "0000000000000000051f22685492e96581b900b4ed9ee5befd871f63c23c8904"));
    assert_eq!(mainnet.deposit_confirmations, Some(1));
    assert_eq!(mainnet.sidechain_server.api, ServerApi::Sidepot);
    assert_eq!(mainnet.sidechain_server.url, "https://explorer.blockfab.org/sidepot/api/v1/l2/feature/game");
    assert_eq!(mainnet.official_apps, ["https://sidepot.cash"]);
    let ecx = mainnet.ecx_asset().expect("its ECX");
    assert_eq!((ecx.id.as_str(), ecx.ticker.as_str(), ecx.decimals), ("", "ECX", 8));
    assert_eq!(domain(), Domain { anchor: anchor_bytes(MAINNET_ANCHOR).unwrap(), slot: 88 });
}

#[test]
fn a_chain_entry_whose_anchor_or_slot_an_entry_cant_carry_is_refused() {
    let mut entry = chain_entry().clone();
    assert!(check_chain_entry(&entry).is_ok());
    entry.networks.get_mut("mainnet").unwrap().params.anchor.height = 982_724;
    assert!(check_chain_entry(&entry).unwrap_err().contains("identity block must be the anchor"));
    let mut entry = chain_entry().clone();
    let mainnet = entry.networks.get_mut("mainnet").unwrap();
    (mainnet.slot, mainnet.chain) = (Some(300), "ecash:mainnet-s300".into());
    assert!(check_chain_entry(&entry).unwrap_err().contains("0 to 255"));
}

#[test]
fn the_anchor_is_the_block_hash_in_header_byte_order() {
    let anchor = anchor_bytes(MAINNET_ANCHOR).unwrap();
    assert_eq!((anchor[0], anchor[1], anchor[23]), (0x33, 0xbf, 0x01), "the reverse of what the node prints");
    assert_eq!(anchor[24..], [0u8; 8], "its leading zeros come last");
    assert!(anchor_bytes("0000").is_none());
    assert!(anchor_bytes(&"zz".repeat(32)).is_none());
}

#[test]
fn the_account_is_the_x_only_key_at_m_300h_88h_0h_of_the_starters_seed() {
    use bitcoin::bip32::{DerivationPath, Xpriv};
    use std::str::FromStr;
    assert_eq!(ecx_sidepot::ACCOUNT_PATH, "300h/88h/0h");
    let secp = Secp256k1::new();
    let seed = bip39::Mnemonic::parse_in(bip39::Language::English, STARTER).unwrap().to_seed("");
    let master = Xpriv::new_master(bitcoin::NetworkKind::Main, &seed).unwrap();
    let key = master.derive_priv(&secp, &DerivationPath::from_str("m/300'/88'/0'").unwrap()).unwrap().private_key;
    let expected = hex(&Keypair::from_secret_key(&secp, &key).x_only_public_key().0.serialize());

    let account = derive_account(STARTER, 20, 20).unwrap();
    assert_eq!(account.receive.len(), 1, "one account, however many addresses are asked for");
    assert!(account.change.is_empty());
    let entry = &account.receive[0];
    assert_eq!(entry.public_key, expected);
    assert_eq!(entry.public_key.len(), 64, "32 bytes, x-only");
    assert_eq!(entry.address, format!("spot:{expected}"));
    assert_eq!(account.descriptor, entry.address);
    assert_eq!((entry.index, entry.script_pubkey.as_str()), (0, ""));
    assert!(derive_account(STARTER, 0, 0).unwrap().receive.is_empty());
}

#[test]
fn anything_but_a_starter_is_refused() {
    for bad in ["", "abandon abandon", "[73c5da0a/84h/0h/0h]xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi"] {
        assert!(derive_account(bad, 1, 0).unwrap_err().contains("invalid Starter"), "{bad}");
        assert_eq!(sign_entry(BUY, bad).unwrap_err().code, RefusalCode::InvalidStarter, "{bad}");
    }
}

#[test]
fn a_deposit_is_credited_to_the_account_named_in_ascii() {
    let d = deposit_destination(STARTER).unwrap();
    assert_eq!(d.address, format!("spot:{}", player()));
    let bytes = unhex(&d.destination);
    assert_eq!(bytes.len(), 69, "spot: and 64 hex digits");
    assert_eq!(std::str::from_utf8(&bytes).unwrap(), d.address);
    assert!(d.address[5..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')), "lowercase, as the game reads it");
    assert_eq!((d.asset.as_str(), d.minimum.as_str()), ("", "1000"));
}

#[test]
fn a_buy_is_128_bytes_laid_out_as_the_spec_says() {
    let (entry, bytes) = signed(BUY);
    assert_eq!((bytes.len(), BUY_LEN), (128, 128));
    assert_eq!(&bytes[0..4], b"SPOT");
    assert_eq!((bytes[4], bytes[5]), (0x00, 0x01), "version 0, kind BUY");
    assert_eq!(bytes[6..10], 7u32.to_le_bytes(), "round");
    assert_eq!(bytes[10..12], 3u16.to_le_bytes(), "keys");
    assert_eq!(bytes[12..20], 150_000u64.to_le_bytes(), "max_price");
    assert_eq!(hex(&bytes[20..52]), player(), "player");
    assert_eq!(bytes[52..60], 42u64.to_le_bytes(), "nonce");
    assert_eq!(bytes[60..64], 5000u32.to_le_bytes(), "expires");
    assert_eq!(bytes[64..128], entry.sig);
    assert_eq!(entry.action, Action::Buy { round: 7, keys: 3, max_price: 150_000 });
    assert_eq!(entry.encode(), bytes, "decode and encode are inverses");
}

#[test]
fn a_cashout_is_142_bytes_laid_out_as_the_spec_says() {
    let (entry, bytes) = signed(CASHOUT);
    assert_eq!((bytes.len(), CASHOUT_LEN), (142, 142));
    assert_eq!(&bytes[0..4], b"SPOT");
    assert_eq!((bytes[4], bytes[5]), (0x00, 0x02), "version 0, kind CASHOUT");
    assert_eq!(bytes[6..14], 250_000u64.to_le_bytes(), "amount");
    assert_eq!(hex(&bytes[14..34]), "00112233445566778899aabbccddeeff00112233", "dest");
    assert_eq!(hex(&bytes[34..66]), player(), "player");
    assert_eq!(bytes[66..74], 43u64.to_le_bytes(), "nonce");
    assert_eq!(bytes[74..78], 5001u32.to_le_bytes(), "expires");
    assert_eq!(bytes[78..142], entry.sig);
    assert_eq!(entry.encode(), bytes);
}

#[test]
fn the_signature_is_bip340_over_the_tagged_hash_of_anchor_slot_and_the_unsigned_bytes() {
    let secp = Secp256k1::verification_only();
    for link in [BUY, CASHOUT] {
        let (entry, bytes) = signed(link);
        // The message, built here from the spec's words alone.
        let tag = sha256::Hash::hash(b"Sidepot/entry").to_byte_array();
        let mut preimage = [&tag[..], &tag[..]].concat();
        let mut anchor = unhex(MAINNET_ANCHOR);
        anchor.reverse();
        preimage.extend_from_slice(&anchor);
        preimage.push(88);
        preimage.extend_from_slice(&bytes[..bytes.len() - 64]);
        let digest = sha256::Hash::hash(&preimage).to_byte_array();
        assert_eq!(entry.sighash(&domain()), digest);
        assert_eq!(tagged_hash(b"Sidepot/entry", &[&anchor, &[88], &bytes[..bytes.len() - 64]]), digest);

        let key = XOnlyPublicKey::from_slice(&entry.player).unwrap();
        let sig = Signature::from_slice(&entry.sig).unwrap();
        secp.verify_schnorr(&sig, &Message::from_digest(digest), &key).expect("a valid BIP340 signature");
        assert!(entry.verify(&secp, &domain()));
    }
}

#[test]
fn the_signature_fails_for_another_slot_another_anchor_or_a_changed_entry() {
    let secp = Secp256k1::verification_only();
    let (entry, _) = signed(BUY);
    let ours = domain();
    assert!(entry.verify(&secp, &ours));
    assert!(!entry.verify(&secp, &Domain { slot: 89, ..ours }), "another Slot");
    assert!(!entry.verify(&secp, &Domain { anchor: anchor_bytes(OTHER_ANCHOR).unwrap(), ..ours }), "a Sidepot anchored in another chain");
    let mut display_order = ours;
    display_order.anchor.reverse();
    assert!(!entry.verify(&secp, &display_order), "the anchor in the node's printed order");
    assert!(!Entry { nonce: 43, ..entry }.verify(&secp, &ours));
    assert!(!Entry { expires: 5001, ..entry }.verify(&secp, &ours));
    assert!(!Entry { action: Action::Buy { round: 7, keys: 4, max_price: 150_000 }, ..entry }.verify(&secp, &ours));
    assert!(!Entry { player: [2; 32], ..entry }.verify(&secp, &ours));
}

#[test]
fn signing_takes_no_randomness_so_the_same_link_makes_the_same_entry() {
    assert_eq!(sign_entry(BUY, STARTER).unwrap(), sign_entry(BUY, STARTER).unwrap());
}

/// `sidepot-cli buy 0101…01 <mainnet anchor> 88 7 3 150000 42 5000` and
/// `sidepot-cli cashout 0101…01 <mainnet anchor> 88 250000 00112233445566778899aabbccddeeff00112233 43 5001`
/// (the reference at `c98535d`, run 2026-11-17), each cut before and after its 64 signature bytes:
/// the reference signs with auxiliary randomness, so only its signature differs from ours.
const REFERENCE_BUY: (&str, &str) = (
    "53504f540001070000000300f0490200000000001b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f2a0000000000000088130000",
    "a15a5d7f557ca66973ced28913eaf2cb3d4ae57ba004c56f1ee4f16be1c7815c58ea5e5261f00730774b735b29bdbc7a7241878db3c065c2050b39ef967779d8",
);
const REFERENCE_CASHOUT: (&str, &str) = (
    "53504f54000290d003000000000000112233445566778899aabbccddeeff001122331b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f2b0000000000000089130000",
    "49a2cafda69d92327efdcd4bc6c7195192b40b5cd83952414b04510fb1b5ff819ff5ae5b58ee419db6ae874031445c7fef63eed3088d73a5de83ab5cfce68f02",
);

#[test]
fn an_entry_is_the_references_byte_for_byte_but_for_the_signature_and_each_verifies_the_others() {
    let secp = Secp256k1::new();
    let keypair = Keypair::from_secret_key(&secp, &SecretKey::from_slice(&[1; 32]).unwrap());
    let ours = domain();
    let cases = [
        (Action::Buy { round: 7, keys: 3, max_price: 150_000 }, 42, 5000, REFERENCE_BUY),
        (Action::Cashout { amount: 250_000, dest: unhex("00112233445566778899aabbccddeeff00112233").try_into().unwrap() }, 43, 5001, REFERENCE_CASHOUT),
    ];
    for (action, nonce, expires, (prefix, reference_sig)) in cases {
        let entry = Entry::sign(&secp, &keypair, &ours, action, nonce, expires);
        let bytes = entry.encode();
        assert_eq!(hex(&bytes[..bytes.len() - 64]), prefix, "every byte before the signature");
        assert!(entry.verify(&secp, &ours), "our signature verifies");
        // The reference's own entry, whole: it decodes to the same entry and its signature verifies
        // under our sighash, so the two agree on the message signed.
        let reference = Entry::decode(&unhex(&format!("{prefix}{reference_sig}"))).unwrap();
        assert_eq!(Entry { sig: entry.sig, ..reference }, entry);
        assert!(reference.verify(&secp, &ours), "the reference's signature verifies under our sighash");
        assert!(!reference.verify(&secp, &Domain { slot: 87, ..ours }));
    }
}

#[test]
fn the_view_says_every_field_read_back_from_the_signed_bytes() {
    let buy = sign_entry(BUY, STARTER).unwrap().view;
    assert_eq!(buy.action, EntryAction::Buy { round: 7, keys: 3, max_price: "150000".into(), max_total: "450000".into() });
    assert_eq!(buy.player, Some(format!("spot:{}", player())));
    assert_eq!((buy.nonce.as_str(), buy.expires, buy.slot, buy.anchor.as_str()), ("42", 5000, 88, MAINNET_ANCHOR));

    let cashout = sign_entry(CASHOUT, STARTER).unwrap().view;
    let dest_address = bitcoin::base58::encode(&unhex("00112233445566778899aabbccddeeff00112233"));
    assert_eq!(cashout.action, EntryAction::Cashout { amount: "250000".into(), dest: "00112233445566778899aabbccddeeff00112233".into(), dest_address });
    // The destination isn't the Starter's own Sidepot address (docs/adr/0022); one to that address says so.
    assert_eq!((buy.dest_yours, cashout.dest_yours), (None, Some(false)));
    let mine = coin_address(STARTER).unwrap();
    let to_me = sign_entry(&format!("sidepot:cashout?amount=0&dest={}&nonce=44&expires=5002", mine.hex), STARTER).unwrap().view;
    assert_eq!(to_me.dest_yours, Some(true));
    assert_eq!(to_me.action, EntryAction::Cashout { amount: "0".into(), dest: mine.hex.clone(), dest_address: mine.address });
    assert_eq!(parse_entry(CASHOUT).unwrap().dest_yours, None, "without the Starter, nothing says whose it is");

    // Without the Starter: the same, less the player.
    let unsigned = parse_entry(BUY).unwrap();
    assert_eq!(unsigned.player, None);
    assert_eq!((unsigned.action, unsigned.nonce, unsigned.expires), (buy.action, buy.nonce, buy.expires));

    let json = serde_json::to_value(&sign_entry(BUY, STARTER).unwrap()).unwrap();
    assert_eq!(json["view"]["kind"], "buy");
    assert_eq!(json["view"]["maxPrice"], "150000");
    assert_eq!(json["view"]["maxTotal"], "450000");
    assert_eq!(json["entry"].as_str().unwrap().len(), 256);
    assert_eq!(serde_json::to_value(parse_entry(CASHOUT).unwrap()).unwrap()["kind"], "cashout");
}

#[test]
fn a_link_gives_its_parameters_in_any_order_and_the_largest_numbers_fit() {
    let shuffled = parse_action("sidepot:buy?expires=5000&nonce=42&max_price=150000&keys=3&round=7").unwrap();
    assert_eq!(shuffled, parse_action(BUY).unwrap());
    let max = parse_action("sidepot:buy?round=4294967295&keys=1000&max_price=18446744073709551615&nonce=18446744073709551615&expires=4294967295").unwrap();
    assert_eq!(max.action, Action::Buy { round: u32::MAX, keys: 1000, max_price: u64::MAX });
    assert_eq!((max.nonce, max.expires), (u64::MAX, u32::MAX));
    let view = parse_entry("sidepot:buy?round=1&keys=1000&max_price=18446744073709551615&nonce=0&expires=0").unwrap();
    assert_eq!(view.action, EntryAction::Buy { round: 1, keys: 1000, max_price: "18446744073709551615".into(), max_total: "18446744073709551615000".into() });

    let all = parse_action("sidepot:cashout?amount=0&dest=00112233445566778899AABBCCDDEEFF00112233&nonce=1&expires=2").unwrap();
    assert_eq!(all.action, Action::Cashout { amount: 0, dest: unhex("00112233445566778899aabbccddeeff00112233").try_into().unwrap() });
}

#[test]
fn a_link_that_isnt_sidepots_or_asks_what_the_game_wont_take_is_refused() {
    let invalid = [
        "",
        "sidepot:",
        "sidepot:buy",
        "flush:buy?round=7&keys=3&max_price=150000&nonce=42&expires=5000",
        "SIDEPOT:buy?round=7&keys=3&max_price=150000&nonce=42&expires=5000",
        "sidepot:Buy?round=7&keys=3&max_price=150000&nonce=42&expires=5000",
        // A parameter missing, twice, unknown, or without a value.
        "sidepot:buy?round=7&keys=3&max_price=150000&nonce=42",
        "sidepot:buy?round=7&round=7&keys=3&max_price=150000&nonce=42&expires=5000",
        "sidepot:buy?round=7&keys=3&max_price=150000&nonce=42&expires=5000&dest=00112233445566778899aabbccddeeff00112233",
        "sidepot:buy?round=7&keys=3&max_price=150000&nonce=42&expires",
        "sidepot:buy?round=7&keys=3&max_price=150000&nonce=42&expires=5000&",
        // Keys outside 1..=1000.
        "sidepot:buy?round=7&keys=0&max_price=150000&nonce=42&expires=5000",
        "sidepot:buy?round=7&keys=1001&max_price=150000&nonce=42&expires=5000",
        // Numbers that aren't plain decimals, or don't fit their field.
        "sidepot:buy?round=4294967296&keys=3&max_price=150000&nonce=42&expires=5000",
        "sidepot:buy?round=7&keys=3&max_price=18446744073709551616&nonce=42&expires=5000",
        "sidepot:buy?round=7&keys=3&max_price=150000&nonce=42&expires=4294967296",
        "sidepot:buy?round=07&keys=3&max_price=150000&nonce=42&expires=5000",
        "sidepot:buy?round=+7&keys=3&max_price=150000&nonce=42&expires=5000",
        "sidepot:buy?round=-7&keys=3&max_price=150000&nonce=42&expires=5000",
        "sidepot:buy?round=7&keys=3&max_price=0.0015&nonce=42&expires=5000",
        "sidepot:buy?round=7&keys=3&max_price=&nonce=42&expires=5000",
        "sidepot:buy?round=%37&keys=3&max_price=150000&nonce=42&expires=5000",
        // A destination that isn't 20 bytes of hex.
        "sidepot:cashout?amount=1&dest=0011&nonce=1&expires=2",
        "sidepot:cashout?amount=1&dest=zz112233445566778899aabbccddeeff00112233&nonce=1&expires=2",
        "sidepot:cashout?amount=1&dest=0x112233445566778899aabbccddeeff00112233&nonce=1&expires=2",
        "sidepot:cashout?amount=1&nonce=1&expires=2",
        "sidepot:cashout?amount=1&dest=00112233445566778899aabbccddeeff00112233&nonce=1&expires=2&round=1",
    ];
    for link in invalid {
        assert_eq!(parse_action(link).unwrap_err().code, RefusalCode::InvalidAction, "{link}");
        assert_eq!(sign_entry(link, STARTER).unwrap_err().code, RefusalCode::InvalidAction, "{link}");
    }
    let long = format!("{BUY}&{}", "x".repeat(600));
    assert!(parse_action(&long).unwrap_err().message.contains("too long"));
    // An action of Sidepot's the wallet doesn't make is told apart: 4200 to the app, not a bad link.
    assert_eq!(parse_action("sidepot:claim?nonce=1&expires=2").unwrap_err().code, RefusalCode::UnsupportedAction);
}

#[test]
fn bytes_that_arent_an_entry_dont_decode() {
    let (_, bytes) = signed(BUY);
    assert_eq!(Entry::decode(&bytes[..5]), Err(DecodeError::Length(5)));
    assert_eq!(Entry::decode(&bytes[..127]), Err(DecodeError::Length(127)));
    assert_eq!(Entry::decode(&[&bytes[..], &[0]].concat()), Err(DecodeError::Length(129)));
    let with = |at: usize, byte: u8| {
        let mut changed = bytes.clone();
        changed[at] = byte;
        Entry::decode(&changed)
    };
    assert_eq!(with(0, b'X'), Err(DecodeError::Magic));
    assert_eq!(with(4, 1), Err(DecodeError::Version(1)));
    assert_eq!(with(5, 3), Err(DecodeError::Kind(3)));
    assert_eq!(with(5, 2), Err(DecodeError::Length(128)), "a cashout is 142 bytes");
}
