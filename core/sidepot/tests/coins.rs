//! The Sidepot sidechain's coins (docs/adr/0022) against its node. `fixtures/thunder-vectors.json`
//! was written by the node's own types (`thunder_types`, through `thunder-vectors/`): keys and
//! addresses, coins and transactions with their canonical bytes, hashes and txids, and signatures.
//! `fixtures/wallet-signed.json` holds transactions this module signed, as the same program read
//! and verified them with the node's code: the module must still make exactly those.
//! The wallet's own spends are of mainnet, the one network Sidepot's Chain Entry names.
use bitcoin::bip32::{DerivationPath, Xpriv};
use bitcoin::secp256k1::Secp256k1;
use bitcoin::NetworkKind;
use curve25519_dalek::scalar::Scalar;
use ecx_sidepot::coins::{main_address, main_script, COIN_KEY_CONTEXT};
use ecx_sidepot::thunder::{authorized_from_json, verify, Address, Authorization, Content, OutPoint, PointedOutput, SigningKey, Transaction};
use ecx_sidepot::{build_spend, coin_address, decode_spend, declare, derive_account, sign_spend, RefusalCode, COIN_PATH};
use serde_json::{json, Value};
use std::str::FromStr;

const STARTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/// Another wallet's Starter.
const OTHER_STARTER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";
/// STARTER's Sidepot address: pinned, so a change to the derivation can't pass unseen.
const MY_ADDRESS: &str = "4Pmyp1gZYtnBZLpH6S1QpUCrKC7j";
/// Someone else's Sidepot address (the fixtures' second key).
const THEIR_ADDRESS: &str = "4J1rRRiAKd1AaiRsHN49aK1BtDbs";
/// Main-chain addresses of mainnet: P2WPKH, P2WSH, P2TR, P2PKH, P2SH.
const MAIN: [&str; 5] = [
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
];

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn arr<const N: usize>(hex: &str) -> [u8; N] {
    unhex(hex).try_into().unwrap()
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/thunder-vectors.json")).unwrap()
}

fn list<'a>(vectors: &'a Value, name: &str) -> &'a Vec<Value> {
    vectors[name].as_array().unwrap()
}

/// A coin as a server lists it: `kind` Regular or Coinbase, its txid 32 bytes of `n`.
fn coin(kind: &str, n: u8, vout: u32, address: &str, sats: u64) -> Value {
    json!({ "outpoint": { kind: { "txid": hex(&[n; 32]), "vout": vout } }, "output": { "address": address, "content": { "Value": sats } } })
}

fn deposit_coin(n: u8, vout: u32, address: &str, sats: u64) -> Value {
    json!({ "outpoint": { "Deposit": format!("{}:{vout}", hex(&[n; 32])) }, "output": { "address": address, "content": { "Value": sats } } })
}

/// The wallet's coins in every test: 2,000,000, 300,000 and 5,000,000 sats, one of each kind of outpoint.
fn my_coins() -> Vec<Value> {
    vec![coin("Regular", 1, 0, MY_ADDRESS, 2_000_000), coin("Coinbase", 2, 3, MY_ADDRESS, 300_000), deposit_coin(3, 1, MY_ADDRESS, 5_000_000)]
}

fn transfer(coins: &[Value], to: &str, amount: u64, fee: u64) -> String {
    json!({ "coins": coins, "pay": { "kind": "transfer", "to": to, "amount": amount.to_string() }, "fee": fee.to_string() }).to_string()
}

fn withdrawal(coins: &[Value], to: &str, amount: u64, main_fee: u64, fee: u64) -> String {
    json!({ "coins": coins, "pay": { "kind": "withdrawal", "mainAddress": to, "amount": amount.to_string(), "mainFee": main_fee.to_string() }, "fee": fee.to_string() }).to_string()
}

/// A move of `amount` sats into the Starter's own game account (docs/adr/0023).
fn game(coins: &[Value], amount: u64, fee: u64) -> String {
    json!({ "coins": coins, "pay": { "kind": "game", "amount": amount.to_string() }, "fee": fee.to_string() }).to_string()
}

/// STARTER's game account (its x-only key at m/300'/88'/0'): pinned, as the fixtures name it.
const MY_ACCOUNT: &str = "0f2ffb3eef6d464fc93b8132a3d95da4b3fb7db57a4dfda30dca200e1137fb5b";

/// The built spend's transaction and the coins it names.
fn parts(payload: &str) -> (Transaction, Vec<PointedOutput>) {
    let value: Value = serde_json::from_str(payload).unwrap();
    let coins = value["coins"].as_array().unwrap().iter().map(|c| PointedOutput::from_json(c).unwrap()).collect();
    (Transaction::from_json(&value["transaction"]).unwrap(), coins)
}

fn view(payload: &str) -> Value {
    serde_json::to_value(decode_spend(payload, STARTER).unwrap()).unwrap()
}

// ---- The node's formats, against the node's own bytes ----

#[test]
fn a_key_gives_the_nodes_verifying_key_and_address() {
    let vectors = vectors();
    assert!(list(&vectors, "keys").len() >= 4);
    for case in list(&vectors, "keys") {
        let key = SigningKey::from_bytes(&arr(case["scalar"].as_str().unwrap())).unwrap();
        assert_eq!(hex(&key.verifying_key()), case["verifyingKey"]);
        assert_eq!(key.address().base58(), case["address"]);
        assert_eq!(hex(&key.address().0), case["addressBytes"]);
        assert_eq!(Address::parse(case["address"].as_str().unwrap()), Some(key.address()));
    }
}

#[test]
fn zero_and_a_scalar_past_the_field_are_no_key() {
    assert!(SigningKey::from_bytes(&[0; 32]).is_none());
    assert!(SigningKey::from_bytes(&[0xff; 32]).is_none(), "not a canonical scalar");
    assert!(SigningKey::from_scalar(Scalar::ZERO).is_none());
}

#[test]
fn a_coin_has_the_nodes_canonical_bytes_hash_and_json() {
    let vectors = vectors();
    let cases = list(&vectors, "pointedOutputs");
    // Every kind of outpoint, both contents, and every kind of main-chain address on two networks.
    assert!(cases.len() >= 17);
    for case in cases {
        let coin = PointedOutput::from_json(&case["json"]).unwrap();
        assert_eq!(hex(&coin.encode()), case["borsh"], "{}", case["json"]);
        assert_eq!(hex(&coin.hash()), case["hash"]);
        assert_eq!(coin.to_json(), case["json"]);
    }
    let kinds = |f: fn(&PointedOutput) -> bool| cases.iter().filter(|c| f(&PointedOutput::from_json(&c["json"]).unwrap())).count();
    assert!(kinds(|c| matches!(c.outpoint, OutPoint::Regular { .. })) > 0);
    assert!(kinds(|c| matches!(c.outpoint, OutPoint::Coinbase { .. })) > 0);
    assert!(kinds(|c| matches!(c.outpoint, OutPoint::Deposit { .. })) > 0);
    assert_eq!(kinds(|c| matches!(c.output.content, Content::Withdrawal { .. })), 10);
}

#[test]
fn a_transaction_has_the_nodes_canonical_bytes_txid_and_json() {
    let vectors = vectors();
    let cases = list(&vectors, "transactions");
    assert!(cases.len() >= 5);
    for case in cases {
        let tx = Transaction::from_json(&case["json"]).unwrap();
        assert_eq!(hex(&tx.encode()), case["borsh"]);
        assert_eq!(hex(&tx.txid()), case["txid"]);
        assert_eq!(tx.to_json(), case["json"]);
    }
}

#[test]
fn the_nodes_signatures_verify_and_a_changed_one_doesnt() {
    let vectors = vectors();
    let cases = list(&vectors, "signatures");
    assert!(cases.len() >= 16);
    for case in cases {
        let key: [u8; 32] = arr(case["verifyingKey"].as_str().unwrap());
        let message = unhex(case["message"].as_str().unwrap());
        let signature: [u8; 64] = arr(case["signature"].as_str().unwrap());
        assert_eq!(SigningKey::from_bytes(&arr(case["scalar"].as_str().unwrap())).unwrap().verifying_key(), key);
        assert_eq!(Authorization::from_json(&case["authorization"]).unwrap(), Authorization { verifying_key: key, signature });
        assert_eq!(Authorization { verifying_key: key, signature }.to_json(), case["authorization"]);
        assert!(verify(&key, &message, &signature));
        // Any other message, key, R or z fails.
        assert!(!verify(&key, &[&message[..], &[0]].concat(), &signature));
        for bit in [0, 100, 255, 256, 300, 500] {
            let mut changed = signature;
            changed[bit / 8] ^= 1 << (bit % 8);
            assert!(!verify(&key, &message, &changed), "bit {bit}");
        }
        let mut other = key;
        other[0] ^= 1;
        assert!(!verify(&other, &message, &signature));
    }
}

#[test]
fn a_transaction_the_nodes_wallet_signed_reads_back_and_verifies() {
    let vectors = vectors();
    let cases = list(&vectors, "authorized");
    assert!(cases.len() >= 4);
    for case in cases {
        let (tx, authorizations) = authorized_from_json(&case["json"]).unwrap();
        assert_eq!(hex(&tx.txid()), case["txid"]);
        assert_eq!(authorizations.len(), tx.inputs.len());
        for authorization in &authorizations {
            assert!(verify(&authorization.verifying_key, &tx.encode(), &authorization.signature));
            assert_eq!(Address::of_key(&authorization.verifying_key).base58(), case["address"]);
        }
    }
}

#[test]
fn a_signature_made_with_a_nonce_verifies_and_a_zero_nonce_is_refused() {
    let vectors = vectors();
    let key = SigningKey::from_bytes(&arr(list(&vectors, "keys")[0]["scalar"].as_str().unwrap())).unwrap();
    let signature = key.sign_with_nonce(&Scalar::from(7u64), b"sidepot").unwrap();
    assert!(verify(&key.verifying_key(), b"sidepot", &signature));
    assert!(key.sign_with_nonce(&Scalar::ZERO, b"sidepot").is_none());
}

#[test]
fn json_that_isnt_the_nodes_is_refused() {
    let good = coin("Regular", 1, 0, THEIR_ADDRESS, 5);
    assert!(PointedOutput::from_json(&good).is_ok());
    let with = |pointer: &str, value: Value| {
        let mut changed = good.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        PointedOutput::from_json(&changed)
    };
    assert!(with("/outpoint", json!({ "Regular": { "txid": "00", "vout": 0 } })).is_err());
    assert!(with("/outpoint", json!({ "Regular": { "txid": hex(&[1; 32]), "vout": 4294967296u64 } })).is_err());
    assert!(with("/outpoint", json!({ "Regular": { "txid": hex(&[1; 32]), "vout": 0 }, "Coinbase": { "txid": hex(&[1; 32]), "vout": 0 } })).is_err());
    assert!(with("/outpoint", json!({ "Other": { "txid": hex(&[1; 32]), "vout": 0 } })).is_err());
    assert!(with("/outpoint", json!({ "Deposit": format!("{}:01", hex(&[1; 32])) })).is_err());
    assert!(with("/outpoint", json!({ "Deposit": format!("{}:+1", hex(&[1; 32])) })).is_err());
    assert!(with("/outpoint", json!({ "Deposit": format!("{}:4294967296", hex(&[1; 32])) })).is_err());
    assert!(with("/output/address", json!("abc")).is_err());
    assert!(with("/output/address", json!(format!("{THEIR_ADDRESS}1"))).is_err());
    assert!(with("/output/content", json!({ "Value": -1 })).is_err());
    assert!(with("/output/content", json!({ "Value": "5" })).is_err());
    assert!(with("/output/content", json!({ "Withdrawal": { "value": 1, "main_fee": 1, "main_address": "nowhere" } })).is_err());
    assert!(with("/output/content", json!({ "Withdrawal": { "value": 1, "main_fee": 1, "main_address": MAIN[0], "more": 1 } })).is_err());
    // A transaction with a proof isn't one the wallet reads.
    let tx = json!({ "inputs": [], "proof": { "targets": [1], "hashes": [] }, "outputs": [] });
    assert!(Transaction::from_json(&tx).is_err());
    assert!(Transaction::from_json(&json!({ "inputs": [[good["outpoint"], [1, 2, 3]]], "proof": { "targets": [], "hashes": [] }, "outputs": [] })).is_err());
}

// ---- The wallet's address ----

#[test]
fn the_address_is_of_the_key_at_m_300h_88h_1h_hashed_onto_the_scalar_field() {
    let address = coin_address(STARTER).unwrap();
    assert_eq!(COIN_PATH, "300h/88h/1h");
    assert_eq!(address.address, MY_ADDRESS);

    // By hand: the BIP39 seed, the BIP32 key at the path, BLAKE3's key derivation, 64 bytes reduced.
    let seed = bip39::Mnemonic::parse_in(bip39::Language::English, STARTER).unwrap().to_seed("");
    let master = Xpriv::new_master(NetworkKind::Main, &seed).unwrap();
    let node = master.derive_priv(&Secp256k1::new(), &DerivationPath::from_str("m/300'/88'/1'").unwrap()).unwrap();
    let mut wide = [0u8; 64];
    blake3::Hasher::new_derive_key(COIN_KEY_CONTEXT).update(&node.private_key.secret_bytes()).finalize_xof().fill(&mut wide);
    let scalar = Scalar::from_bytes_mod_order_wide(&wide);
    // A valid signing key as the node reads one: canonical bytes of a nonzero scalar.
    let key = SigningKey::from_bytes(&scalar.to_bytes()).unwrap();
    assert_eq!(hex(&key.verifying_key()), address.public_key);
    assert_eq!(key.address().base58(), address.address);
    assert_eq!(hex(&key.address().0), address.hex);
    assert_eq!(address.hex.len(), 40);
    assert_eq!(Address::parse(&address.address).unwrap().0.to_vec(), unhex(&address.hex));
}

#[test]
fn the_coin_key_is_not_the_game_accounts_and_differs_by_starter() {
    let address = coin_address(STARTER).unwrap();
    let account = derive_account(STARTER, 1, 0).unwrap();
    assert_ne!(address.public_key, account.receive[0].public_key);
    assert_ne!(coin_address(OTHER_STARTER).unwrap().address, address.address);
    assert_eq!(coin_address(STARTER).unwrap(), address);
    assert!(coin_address("not a starter").unwrap_err().contains("invalid Starter"));
    assert!(declare().capabilities.contains(&"coins".to_string()));
}

// ---- Building, reading and signing spends ----

#[test]
fn a_transfer_spends_the_largest_coin_first_and_returns_the_change() {
    let built = build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 500_000, 1_000), STARTER).unwrap();
    let (tx, coins) = parts(&built.payload);
    assert_eq!(coins.len(), 1);
    assert_eq!(coins[0].to_json(), my_coins()[2], "the 5,000,000 sat coin alone covers it");
    assert_eq!(built.spent, [my_coins()[2]["outpoint"].clone()]);
    assert_eq!(tx.inputs, [(coins[0].outpoint, coins[0].hash())]);
    assert_eq!(tx.outputs.len(), 2);
    assert_eq!((tx.outputs[0].address.base58().as_str(), &tx.outputs[0].content), (THEIR_ADDRESS, &Content::Value(500_000)));
    assert_eq!((tx.outputs[1].address.base58().as_str(), &tx.outputs[1].content), (MY_ADDRESS, &Content::Value(4_499_000)));

    assert_eq!(
        view(&built.payload),
        json!({
            "kind": "clear",
            "view": {
                "dangerousModes": [],
                "inputs": [{ "index": 0, "asset": "", "amount": "5000000", "yours": true }],
                "outputs": [
                    { "index": 0, "asset": "", "amount": "500000", "destination": { "kind": "address", "address": THEIR_ADDRESS, "yours": false } },
                    { "index": 1, "asset": "", "amount": "4499000", "destination": { "kind": "address", "address": MY_ADDRESS, "yours": true } },
                ],
                "fee": { "asset": "", "amount": "1000" },
            }
        })
    );
}

#[test]
fn a_transfer_of_everything_takes_every_coin_and_leaves_no_change() {
    let built = build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 7_299_000, 1_000), STARTER).unwrap();
    let (tx, coins) = parts(&built.payload);
    let values: Vec<_> = coins.iter().map(|c| c.output.content.consumed().unwrap()).collect();
    assert_eq!(values, [5_000_000, 2_000_000, 300_000]);
    assert_eq!(tx.outputs.len(), 1);
    assert_eq!(view(&built.payload)["view"]["fee"]["amount"], "1000");
    // One sat more is more than the coins hold.
    let refusal = build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 7_299_001, 1_000), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InsufficientFunds);
    assert!(refusal.message.contains("0.07300000 ECX") && refusal.message.contains("0.07300001 ECX"), "{}", refusal.message);
}

#[test]
fn only_the_wallets_own_plain_coins_are_spent() {
    let mut coins = vec![
        coin("Regular", 9, 0, THEIR_ADDRESS, 90_000_000),
        coin("Regular", 8, 0, MY_ADDRESS, 0),
        json!({ "outpoint": { "Regular": { "txid": hex(&[7; 32]), "vout": 0 } }, "output": { "address": MY_ADDRESS, "content": { "Withdrawal": { "value": 80_000_000, "main_fee": 1000, "main_address": MAIN[0] } } } }),
    ];
    let refusal = build_spend(&transfer(&coins, THEIR_ADDRESS, 1_000, 1_000), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InsufficientFunds);
    assert!(refusal.message.contains("hold 0.00000000 ECX"), "{}", refusal.message);
    coins.extend(my_coins());
    let (_, spent) = parts(&build_spend(&transfer(&coins, THEIR_ADDRESS, 1_000, 1_000), STARTER).unwrap().payload);
    assert_eq!(spent[0].to_json(), my_coins()[2]);
    // The same coin listed twice is a server's mistake, not two coins: with the same value or another.
    coins.push(my_coins()[0].clone());
    assert!(build_spend(&transfer(&coins, THEIR_ADDRESS, 1_000, 1_000), STARTER).unwrap_err().message.contains("twice"));
    *coins.last_mut().unwrap() = coin("Regular", 1, 0, MY_ADDRESS, 9_000_000);
    assert!(build_spend(&transfer(&coins, THEIR_ADDRESS, 1_000, 1_000), STARTER).unwrap_err().message.contains("twice"));
    // A coin the wallet can't read is refused, not skipped: the list isn't the node's.
    let refusal = build_spend(&transfer(&[json!({ "outpoint": 1 })], THEIR_ADDRESS, 1_000, 1_000), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::Malformed);
}

#[test]
fn a_transfer_to_something_that_isnt_a_sidepot_address_or_of_nothing_is_refused() {
    for to in ["", "spot:00", MAIN[0], "0OIl", &format!("{THEIR_ADDRESS}{THEIR_ADDRESS}")] {
        let refusal = build_spend(&transfer(&my_coins(), to, 1_000, 1_000), STARTER).unwrap_err();
        assert!(refusal.message.contains("isn't a Sidepot address"), "{to}: {}", refusal.message);
    }
    assert!(build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 0, 1_000), STARTER).unwrap_err().message.contains("more than 0"));
    let order = json!({ "coins": my_coins(), "pay": { "kind": "transfer", "to": THEIR_ADDRESS, "amount": "1.5" }, "fee": "1000" }).to_string();
    assert!(build_spend(&order, STARTER).unwrap_err().message.contains("whole number of sats"));
    let order = json!({ "coins": my_coins(), "pay": { "kind": "transfer", "to": THEIR_ADDRESS, "amount": "18446744073709551615" }, "fee": "1" }).to_string();
    assert!(build_spend(&order, STARTER).unwrap_err().message.contains("more ECX than exists"));
    assert_eq!(build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 1_000, 1_000), "not a starter").unwrap_err().code, RefusalCode::InvalidStarter);
    assert_eq!(build_spend("{}", STARTER).unwrap_err().code, RefusalCode::Malformed);
    // Spaces around a pasted address are the user's, not the address's.
    assert!(build_spend(&transfer(&my_coins(), &format!("  {THEIR_ADDRESS}\n"), 1_000, 1_000), STARTER).is_ok());
}

#[test]
fn a_withdrawal_request_stays_at_the_wallets_address_and_takes_its_main_chain_fee_too() {
    let built = build_spend(&withdrawal(&my_coins(), MAIN[0], 1_000_000, 2_000, 1_000), STARTER).unwrap();
    let (tx, _) = parts(&built.payload);
    assert_eq!(tx.outputs[0].address.base58(), MY_ADDRESS);
    let Content::Withdrawal { value, main_fee, main_address: to, script } = &tx.outputs[0].content else { panic!("not a withdrawal") };
    assert_eq!((*value, *main_fee, to.as_str()), (1_000_000, 2_000, MAIN[0]));
    assert_eq!(hex(script), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
    // 5,000,000 in; 1,000,000 + 2,000 to the withdrawal, 1,000 fee, the rest back.
    assert_eq!(tx.outputs[1].content, Content::Value(3_997_000));
    assert_eq!(
        view(&built.payload)["view"],
        json!({
            "dangerousModes": [{ "kind": "withdrawalBurn", "output": 0 }],
            "inputs": [{ "index": 0, "asset": "", "amount": "5000000", "yours": true }],
            "outputs": [
                { "index": 0, "asset": "", "amount": "1002000", "destination": { "kind": "withdrawal", "l1Address": MAIN[0], "l1ScriptPubkey": "0014751e76e8199196d454941c45d1b3a323f1433bd6", "payout": "1000000", "parentFee": "2000" } },
                { "index": 1, "asset": "", "amount": "3997000", "destination": { "kind": "address", "address": MY_ADDRESS, "yours": true } },
            ],
            "fee": { "asset": "", "amount": "1000" },
        })
    );
}

#[test]
fn a_withdrawal_pays_every_kind_of_main_chain_address_of_this_network_and_no_other() {
    for to in MAIN {
        let built = build_spend(&withdrawal(&my_coins(), to, 100_000, 500, 1_000), STARTER).unwrap();
        assert_eq!(view(&built.payload)["view"]["outputs"][0]["destination"]["l1Address"], to);
        assert_eq!(main_address(main_script(to).unwrap().as_bytes()).as_deref(), Some(to));
    }
    // Upper case is the same bech32 address: written back in lower case, as the node writes it.
    let built = build_spend(&withdrawal(&my_coins(), &MAIN[0].to_uppercase(), 100_000, 500, 1_000), STARTER).unwrap();
    assert_eq!(view(&built.payload)["view"]["outputs"][0]["destination"]["l1Address"], MAIN[0]);
    // Regtest's and testnet's addresses, a Sidepot address, a game account, a future segwit version, a bad checksum.
    for to in [
        "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
        "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
        "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
        "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        THEIR_ADDRESS,
        "spot:0000000000000000000000000000000000000000000000000000000000000000",
        "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",
        "",
    ] {
        let refusal = build_spend(&withdrawal(&my_coins(), to, 100_000, 500, 1_000), STARTER).unwrap_err();
        assert!(refusal.message.contains("isn't a main-chain (eCash) address"), "{to}: {}", refusal.message);
    }
}

#[test]
fn a_withdrawal_below_the_main_chains_dust_or_with_no_main_chain_fee_is_refused() {
    // 294 sats to P2WPKH, 546 to P2PKH: Bitcoin Core's dust rule, as the main chain relays.
    for (to, dust) in [(MAIN[0], 294), (MAIN[1], 330), (MAIN[2], 330), (MAIN[3], 546), (MAIN[4], 540)] {
        let refusal = build_spend(&withdrawal(&my_coins(), to, dust - 1, 500, 1_000), STARTER).unwrap_err();
        assert_eq!(refusal.code, RefusalCode::Dust, "{to}");
        assert!(refusal.message.contains(&format!("{dust} sats")), "{}", refusal.message);
        assert!(build_spend(&withdrawal(&my_coins(), to, dust, 500, 1_000), STARTER).is_ok());
    }
    let refusal = build_spend(&withdrawal(&my_coins(), MAIN[0], 100_000, 0, 1_000), STARTER).unwrap_err();
    assert!(refusal.message.contains("needs a main-chain fee"));
    // The main-chain fee is paid from the coins too.
    let refusal = build_spend(&withdrawal(&my_coins(), MAIN[0], 7_298_000, 1_001, 1_000), STARTER).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InsufficientFunds);
    assert!(build_spend(&withdrawal(&my_coins(), MAIN[0], 7_298_000, 1_000, 1_000), STARTER).is_ok());
}

#[test]
fn signing_gives_the_nodes_authorized_transaction_one_authorization_per_input() {
    let built = build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 7_000_000, 1_000), STARTER).unwrap();
    let signed = sign_spend(&built.payload, STARTER).unwrap();
    let (tx, authorizations) = authorized_from_json(&serde_json::from_str(&signed.tx).unwrap()).unwrap();
    assert_eq!(tx, parts(&built.payload).0);
    assert_eq!(signed.txid, hex(&tx.txid()));
    assert_eq!(signed.txid, hex(blake3::hash(&tx.encode()).as_bytes()));
    assert_eq!((tx.inputs.len(), authorizations.len()), (3, 3));
    for authorization in &authorizations {
        assert_eq!(hex(&authorization.verifying_key), coin_address(STARTER).unwrap().public_key);
        assert!(verify(&authorization.verifying_key, &tx.encode(), &authorization.signature));
    }
    // No randomness: the same spend signs to the same bytes, and another spend to another signature.
    assert_eq!(sign_spend(&built.payload, STARTER).unwrap(), signed);
    let other = sign_spend(&build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 7_000_001, 1_000), STARTER).unwrap().payload, STARTER).unwrap();
    let (_, other_authorizations) = authorized_from_json(&serde_json::from_str(&other.tx).unwrap()).unwrap();
    assert_ne!(other_authorizations[0].signature[..32], authorizations[0].signature[..32], "another message, another nonce");
}

#[test]
fn a_spend_that_isnt_what_it_says_is_refused_unsigned() {
    let built = build_spend(&transfer(&my_coins(), THEIR_ADDRESS, 500_000, 1_000), STARTER).unwrap();
    let payload: Value = serde_json::from_str(&built.payload).unwrap();
    let refused = |changed: &Value, starter: &str| {
        let text = changed.to_string();
        let (decoded, signed) = (decode_spend(&text, starter), sign_spend(&text, starter));
        let refusal = decoded.unwrap_err();
        assert_eq!(signed.unwrap_err(), refusal, "what isn't shown isn't signed");
        refusal
    };
    let with = |pointer: &str, value: Value| {
        let mut changed = payload.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        changed
    };

    // The coin given for an input holds more than the input's hash commits to: the fee would be a lie.
    assert!(refused(&with("/coins/0/output/content/Value", json!(6_000_000)), STARTER).message.contains("doesn't spend the coin given"));
    assert!(refused(&with("/coins/0/outpoint", my_coins()[0]["outpoint"].clone()), STARTER).message.contains("doesn't spend the coin given"));
    // Another wallet's Starter: none of it is its to sign.
    assert_eq!(refused(&payload, OTHER_STARTER).code, RefusalCode::NothingToSign);
    // Outputs that take more than the coins hold.
    assert_eq!(refused(&with("/transaction/outputs/0/content/Value", json!(5_000_000)), STARTER).code, RefusalCode::InsufficientFunds);
    // The same coin twice.
    let mut twice = payload.clone();
    let (input, coin) = (payload["transaction"]["inputs"][0].clone(), payload["coins"][0].clone());
    twice["transaction"]["inputs"].as_array_mut().unwrap().push(input);
    twice["coins"].as_array_mut().unwrap().push(coin);
    assert!(refused(&twice, STARTER).message.contains("another input already spends"));
    // No inputs, no outputs, a coin too few, a field too many.
    assert!(refused(&with("/transaction/outputs", json!([])), STARTER).message.contains("at least one output"));
    assert!(refused(&with("/coins", json!([])), STARTER).message.contains("names the coin of each"));
    let mut more = payload.clone();
    more["extra"] = json!(1);
    assert_eq!(refused(&more, STARTER).code, RefusalCode::Malformed);
    assert_eq!(decode_spend("not json", STARTER).unwrap_err().code, RefusalCode::Malformed);

    // A withdrawal to another network's address, or held by someone else's address.
    let built = build_spend(&withdrawal(&my_coins(), MAIN[0], 1_000_000, 2_000, 1_000), STARTER).unwrap();
    let payload: Value = serde_json::from_str(&built.payload).unwrap();
    let with = |pointer: &str, value: Value| {
        let mut changed = payload.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        changed
    };
    let regtest = with("/transaction/outputs/0/content/Withdrawal/main_address", json!("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"));
    assert!(refused(&regtest, STARTER).message.contains("isn't a main-chain (eCash) address"));
    assert!(refused(&with("/transaction/outputs/0/address", json!(THEIR_ADDRESS)), STARTER).message.contains("held by another address"));
    // A withdrawal request among the coins can't be spent.
    let request = json!({ "outpoint": { "Regular": { "txid": hex(&[7; 32]), "vout": 0 } }, "output": payload["transaction"]["outputs"][0] });
    let hash = PointedOutput::from_json(&request).unwrap().hash().to_vec();
    let mut spends_request = with("/coins/0", request.clone());
    spends_request["transaction"]["inputs"][0] = json!([request["outpoint"], hash]);
    assert!(refused(&spends_request, STARTER).message.contains("withdrawal request, which no one can spend"));
}

// ---- Moving coins into the game (docs/adr/0023) ----

#[test]
fn a_game_deposit_has_the_nodes_canonical_bytes_json_and_txid_and_the_nodes_signatures_verify() {
    let vectors = vectors();
    let deposits = &vectors["gameDeposits"];
    let outputs = deposits["outputs"].as_array().unwrap();
    assert_eq!(outputs.len(), 4);
    for case in outputs {
        let output = &case["json"];
        assert_eq!(output["address"], "11111111111111111111");
        assert_eq!(Address::parse(output["address"].as_str().unwrap()), Some(Address::ALL_ZEROS));
        let content = Content::from_json(&output["content"]).unwrap();
        let Content::GameDeposit { value, account } = &content else { panic!("not a game deposit") };
        // Tag 2, the value as a little-endian u64, then the account's 32 bytes; after the address's 20 zero bytes.
        let expected = format!("{}02{}{}", "00".repeat(20), hex(&value.to_le_bytes()), hex(account));
        assert_eq!(case["borsh"], expected);
        assert_eq!(content.to_json(), output["content"]);
        assert_eq!(content.consumed(), Some(*value));
    }
    let transactions = deposits["transactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 3);
    for case in transactions {
        let tx = Transaction::from_json(&case["json"]).unwrap();
        assert_eq!(hex(&tx.encode()), case["borsh"]);
        assert_eq!(hex(&tx.txid()), case["txid"]);
        assert_eq!(tx.to_json(), case["json"]);
        assert!(tx.outputs.iter().any(|o| matches!(o.content, Content::GameDeposit { .. })));
        // Each input names its coin by the coin's hash, as for any spend.
        for ((outpoint, hash), input) in tx.inputs.iter().zip(case["inputs"].as_array().unwrap()) {
            assert_eq!(outpoint.to_json(), input["outpoint"]);
            assert_eq!(hex(hash), input["hash"]);
        }
        let (signed, authorizations) = authorized_from_json(&case["authorized"]).unwrap();
        assert_eq!(signed, tx);
        for authorization in &authorizations {
            assert!(verify(&authorization.verifying_key, &tx.encode(), &authorization.signature));
            assert_eq!(Address::of_key(&authorization.verifying_key).base58(), case["address"]);
        }
    }
    // The node reads either case of hex but writes lower case; the wallet reads only what it writes.
    let mut upper = outputs[1]["json"]["content"].clone();
    upper["GameDeposit"]["account"] = json!(MY_ACCOUNT.to_uppercase());
    assert!(Content::from_json(&upper).is_err());
    for bad in [json!({ "GameDeposit": { "value": 1 } }), json!({ "GameDeposit": { "value": 1, "account": "00", } }), json!({ "GameDeposit": { "value": -1, "account": MY_ACCOUNT } }), json!({ "GameDeposit": { "value": 1, "account": MY_ACCOUNT, "x": 1 } })] {
        assert!(Content::from_json(&bad).is_err(), "{bad}");
    }
}

#[test]
fn a_move_into_the_game_pays_the_starters_own_account_with_change_back() {
    assert_eq!(derive_account(STARTER, 1, 0).unwrap().receive[0].public_key, MY_ACCOUNT);
    let built = build_spend(&game(&my_coins(), 500_000, 1_000), STARTER).unwrap();
    let (tx, coins) = parts(&built.payload);
    assert_eq!(coins[0].to_json(), my_coins()[2]);
    assert_eq!(tx.outputs.len(), 2);
    assert_eq!(tx.outputs[0].address, Address::ALL_ZEROS);
    assert_eq!(tx.outputs[0].content, Content::GameDeposit { value: 500_000, account: arr(MY_ACCOUNT) });
    assert_eq!((tx.outputs[1].address.base58().as_str(), &tx.outputs[1].content), (MY_ADDRESS, &Content::Value(4_499_000)));
    assert_eq!(
        view(&built.payload),
        json!({
            "kind": "clear",
            "view": {
                "dangerousModes": [],
                "inputs": [{ "index": 0, "asset": "", "amount": "5000000", "yours": true }],
                "outputs": [
                    { "index": 0, "asset": "", "amount": "500000", "destination": { "kind": "gameAccount", "account": MY_ACCOUNT, "address": format!("spot:{MY_ACCOUNT}"), "yours": true } },
                    { "index": 1, "asset": "", "amount": "4499000", "destination": { "kind": "address", "address": MY_ADDRESS, "yours": true } },
                ],
                "fee": { "asset": "", "amount": "1000" },
            }
        })
    );
    // Everything, with no change; and one sat more than the coins hold.
    let (tx, _) = parts(&build_spend(&game(&my_coins(), 7_299_000, 1_000), STARTER).unwrap().payload);
    assert_eq!(tx.outputs.len(), 1);
    assert_eq!(build_spend(&game(&my_coins(), 7_299_001, 1_000), STARTER).unwrap_err().code, RefusalCode::InsufficientFunds);
    // Signed like any spend.
    let signed = sign_spend(&built.payload, STARTER).unwrap();
    let (tx, authorizations) = authorized_from_json(&serde_json::from_str(&signed.tx).unwrap()).unwrap();
    assert_eq!(signed.txid, hex(&tx.txid()));
    assert!(verify(&authorizations[0].verifying_key, &tx.encode(), &authorizations[0].signature));
}

#[test]
fn a_move_of_nothing_or_one_the_wallet_didnt_build_as_its_own_is_refused_or_shown_as_not_yours() {
    // Nothing, or not a number of sats: refused before anything is built.
    assert!(build_spend(&game(&my_coins(), 0, 1_000), STARTER).unwrap_err().message.contains("more than 0"));
    let order = json!({ "coins": my_coins(), "pay": { "kind": "game", "amount": "1.5" }, "fee": "1000" }).to_string();
    assert!(build_spend(&order, STARTER).unwrap_err().message.contains("whole number of sats"));
    // The order names no account: the wallet moves coins only into its own.
    let order = json!({ "coins": my_coins(), "pay": { "kind": "game", "amount": "1000", "account": MY_ACCOUNT }, "fee": "1000" }).to_string();
    assert_eq!(build_spend(&order, STARTER).unwrap_err().code, RefusalCode::Malformed);

    let built = build_spend(&game(&my_coins(), 500_000, 1_000), STARTER).unwrap();
    let payload: Value = serde_json::from_str(&built.payload).unwrap();
    let with = |pointer: &str, value: Value| {
        let mut changed = payload.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        changed.to_string()
    };
    let refused = |text: String| {
        let refusal = decode_spend(&text, STARTER).unwrap_err();
        assert_eq!(sign_spend(&text, STARTER).unwrap_err(), refusal, "what isn't shown isn't signed");
        refusal
    };
    // Someone else's game account: decoded, and shown as not the wallet's own.
    let theirs = derive_account(OTHER_STARTER, 1, 0).unwrap().receive[0].public_key.clone();
    let other = with("/transaction/outputs/0/content/GameDeposit/account", json!(theirs));
    let destination = &view(&other)["view"]["outputs"][0]["destination"];
    assert_eq!(*destination, json!({ "kind": "gameAccount", "account": theirs, "address": format!("spot:{theirs}"), "yours": false }));
    // What the node refuses, the wallet refuses first: nothing moved, an address on it, a key no one could have.
    let value = |v: u64| with("/transaction/outputs/0/content/GameDeposit/value", json!(v));
    assert!(refused(value(0)).message.contains("moves nothing"));
    assert!(refused(with("/transaction/outputs/0/address", json!(MY_ADDRESS))).message.contains("names an address"));
    // 2^256 - 1 is above the field's prime: no x coordinate at all.
    assert!(refused(with("/transaction/outputs/0/content/GameDeposit/account", json!("ff".repeat(32)))).message.contains("isn't a game account"));
    // A game deposit is no coin: none can be an input.
    let deposit = json!({ "outpoint": { "Regular": { "txid": hex(&[6; 32]), "vout": 0 } }, "output": payload["transaction"]["outputs"][0] });
    let hash = PointedOutput::from_json(&deposit).unwrap().hash().to_vec();
    let mut spends_deposit: Value = payload.clone();
    spends_deposit["coins"][0] = deposit.clone();
    spends_deposit["transaction"]["inputs"][0] = json!([deposit["outpoint"], hash]);
    assert!(refused(spends_deposit.to_string()).message.contains("which is no coin"));
}

// ---- What the node made of the wallet's own transactions ----

/// The spends the node's code was shown: a name, the order's coins and payment, and the fee.
fn wallet_cases() -> Vec<(&'static str, String)> {
    let coins = my_coins();
    vec![
        ("a transfer with change", transfer(&coins, THEIR_ADDRESS, 500_000, 1_000)),
        ("a transfer of everything, from a coin of each kind of outpoint", transfer(&coins, THEIR_ADDRESS, 7_299_000, 1_000)),
        ("a transfer to the wallet's own address", transfer(&coins[..2], MY_ADDRESS, 2_100_000, 250)),
        ("a withdrawal request to a P2WPKH address", withdrawal(&coins, MAIN[0], 1_000_000, 2_000, 1_000)),
        ("a withdrawal request to a P2WSH address", withdrawal(&coins, MAIN[1], 5_500_000, 10_000, 1_000)),
        ("a withdrawal request to a P2TR address", withdrawal(&coins, MAIN[2], 330, 1, 0)),
        ("a withdrawal request to a P2PKH address", withdrawal(&coins[..1], MAIN[3], 1_998_000, 1_000, 1_000)),
        ("a withdrawal request to a P2SH address", withdrawal(&coins, MAIN[4], 7_000_000, 298_000, 1_000)),
        ("a move into the game account, with change", game(&coins, 500_000, 1_000)),
        ("a move of every coin into the game account", game(&coins, 7_299_000, 1_000)),
    ]
}

/// Each case signed: what `thunder-vectors verify` reads.
fn wallet_signed() -> Vec<Value> {
    wallet_cases()
        .into_iter()
        .map(|(name, order)| {
            let built = build_spend(&order, STARTER).unwrap();
            let signed = sign_spend(&built.payload, STARTER).unwrap();
            let fee = view(&built.payload)["view"]["fee"]["amount"].clone();
            json!({ "name": name, "tx": serde_json::from_str::<Value>(&signed.tx).unwrap(), "address": MY_ADDRESS, "fee": fee, "txid": signed.txid })
        })
        .collect()
}

/// `fixtures/wallet-signed.json` is `thunder-vectors verify`'s answer to these very transactions:
/// the node's types read each from its JSON, its batch verifier accepted every authorization over
/// its own canonical bytes, and each signer's address was the wallet's. The wallet signs without
/// randomness, so it must still make them byte for byte, and agree on their canonical bytes and txids.
///
/// To write them out again for that program (see `thunder-vectors/README.md`), run this test with
/// `ECX_SIDEPOT_WALLET_SIGNED=<file>`.
#[test]
fn the_node_read_and_verified_exactly_the_transactions_the_wallet_signs() {
    let signed = wallet_signed();
    if let Some(path) = std::env::var_os("ECX_SIDEPOT_WALLET_SIGNED") {
        std::fs::write(path, serde_json::to_string_pretty(&signed).unwrap()).unwrap();
    }
    let checked: Vec<Value> = serde_json::from_str(include_str!("fixtures/wallet-signed.json")).unwrap();
    assert_eq!(checked.len(), signed.len());
    for (ours, theirs) in signed.iter().zip(&checked) {
        let name = &ours["name"];
        assert_eq!(theirs["name"], *name);
        assert_eq!(theirs["tx"], ours["tx"], "{name}: not the transaction the node verified");
        assert_eq!(theirs["address"], MY_ADDRESS);
        assert_eq!(theirs["txid"], ours["txid"], "{name}: the node's txid");
        let (tx, authorizations) = authorized_from_json(&ours["tx"]).unwrap();
        assert_eq!(theirs["borsh"], hex(&tx.encode()), "{name}: the node's canonical bytes");
        assert_eq!(authorizations.len(), tx.inputs.len());
    }
}
