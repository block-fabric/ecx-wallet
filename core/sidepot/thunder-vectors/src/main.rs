//! Test vectors from the Sidepot node's own types (`thunder_types`), and the node's check of
//! transactions the wallet signed.
//!
//!   thunder-vectors generate          the fixtures, as JSON, on stdout
//!   thunder-vectors verify < file     checks each `{ "tx", "address" }` of a JSON list as the node
//!                                     does, and prints each with its canonical bytes and txid
//!
//! Everything here is deterministic: the same node source gives the same fixtures.
use std::io::Read as _;

use anyhow::{Context as _, anyhow, bail, ensure};
use bitcoin::Amount;
use thunder_types::{
    Address, Authorization, AuthorizedTransaction, OutPoint, Output, OutputContent, PointedOutput, Transaction,
    authorization::{self, BatchVerificationContext, SigningKey, VerifyingKey, get_address},
    hashes::hash,
    transaction::Outputs,
};

/// `N` bytes that look random and never change: BLAKE3's XOF over a label.
fn bytes<const N: usize>(label: &str) -> [u8; N] {
    let mut out = [0; N];
    blake3::Hasher::new().update(b"thunder-vectors/").update(label.as_bytes()).finalize_xof().fill(&mut out);
    out
}

/// A seeded generator for the node's own signing, which draws its nonce at random.
fn rng(label: &str) -> rand::rngs::ChaCha20Rng {
    <rand::rngs::ChaCha20Rng as rand::SeedableRng>::from_seed(bytes(label))
}

/// A signing key by label: 64 bytes reduced onto the scalar field, in its canonical 32 bytes.
fn key(label: &str) -> ([u8; 32], SigningKey) {
    let scalar = curve25519_dalek::Scalar::from_bytes_mod_order_wide(&bytes(label)).to_bytes();
    (scalar, SigningKey::deserialize(&scalar).expect("a nonzero scalar"))
}

fn address_of(key: &SigningKey) -> Address {
    get_address(VerifyingKey::from(key))
}

fn regular(label: &str, vout: u32) -> OutPoint {
    OutPoint::Regular { txid: bytes::<32>(label).into(), vout }
}

fn coinbase(label: &str, vout: u32) -> OutPoint {
    OutPoint::Coinbase { txid: bytes::<32>(label).into(), vout }
}

fn deposit(label: &str, vout: u32) -> OutPoint {
    use bitcoin::hashes::Hash as _;
    OutPoint::Deposit(bitcoin::OutPoint { txid: bitcoin::Txid::from_byte_array(bytes(label)), vout })
}

fn value(address: Address, sats: u64) -> Output {
    Output { address, content: OutputContent::Value(Amount::from_sat(sats)) }
}

fn withdrawal(address: Address, value: u64, main_fee: u64, main_address: &str) -> Output {
    Output {
        address,
        content: OutputContent::Withdrawal {
            value: Amount::from_sat(value),
            main_fee: Amount::from_sat(main_fee),
            main_address: main_address.parse().expect("a main-chain address"),
        },
    }
}

/// A game deposit (the node's `OutputContent::GameDeposit`, from commit 824e49c): `value` sats into the
/// game account `account`, at the address of all zeros, as the node requires.
fn game_deposit(account: [u8; 32], value: u64) -> Output {
    Output { address: Address::ALL_ZEROS, content: OutputContent::GameDeposit { value: Amount::from_sat(value), account } }
}

/// Game accounts (BIP340 x-only keys): the wallet's test Starter's own (`abandon … about`, at
/// `m/300'/88'/0'`), secp256k1's generator, and another valid key.
const GAME_ACCOUNTS: [&str; 3] = [
    "0f2ffb3eef6d464fc93b8132a3d95da4b3fb7db57a4dfda30dca200e1137fb5b",
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
];

fn account(i: usize) -> [u8; 32] {
    let mut out = [0; 32];
    const_hex::decode_to_slice(GAME_ACCOUNTS[i], &mut out).expect("64 hex digits");
    out
}

/// Main-chain addresses of every kind a withdrawal may name, on regtest and on mainnet.
const MAIN_ADDRESSES: [&str; 10] = [
    "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
    "bcrt1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qzf4jry",
    "bcrt1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6",
    "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
    "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc",
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
];

fn pointed_outputs(me: Address, other: Address) -> Vec<PointedOutput> {
    let mut all = vec![
        PointedOutput { outpoint: regular("coin a", 0), output: value(me, 2_000_000) },
        PointedOutput { outpoint: regular("coin b", 1), output: value(me, 1) },
        PointedOutput { outpoint: coinbase("coin c", 0), output: value(me, 48_000_000) },
        PointedOutput { outpoint: coinbase("coin d", 7), output: value(other, 0) },
        PointedOutput { outpoint: deposit("coin e", 0), output: value(me, 5_000_000) },
        PointedOutput { outpoint: deposit("coin f", u32::MAX), output: value(other, 2_099_999_997_690_000) },
        PointedOutput { outpoint: regular("coin g", 65_536), output: value(Address::ALL_ZEROS, u64::MAX) },
    ];
    for (i, main_address) in MAIN_ADDRESSES.iter().enumerate() {
        let owner = if i % 2 == 0 { me } else { other };
        all.push(PointedOutput { outpoint: regular("withdrawal", i as u32), output: withdrawal(owner, 100_000 + i as u64, 1_000 * (i as u64 + 1), main_address) });
    }
    all
}

fn spend(inputs: &[PointedOutput], outputs: Vec<Output>) -> Transaction {
    Transaction { inputs: inputs.iter().map(|coin| (coin.outpoint, hash(coin))).collect::<Vec<_>>().into(), outputs: Outputs(outputs), ..Default::default() }
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    const_hex::encode(bytes)
}

fn generate() -> anyhow::Result<serde_json::Value> {
    let labels = ["key one", "key two", "key three", "key four"];
    let keys: Vec<_> = labels.iter().map(|label| key(label)).collect();
    let (me, other) = (address_of(&keys[0].1), address_of(&keys[1].1));

    let keys_json: Vec<_> = keys
        .iter()
        .map(|(scalar, key)| {
            let verifying_key = VerifyingKey::from(key);
            serde_json::json!({
                "scalar": hex(scalar),
                "verifyingKey": hex(verifying_key.to_element().compress().as_bytes()),
                "address": get_address(verifying_key).to_string(),
                "addressBytes": hex(get_address(verifying_key).0),
                "depositAddress": get_address(verifying_key).format_for_deposit(),
            })
        })
        .collect();

    let coins = pointed_outputs(me, other);
    let coins_json = coins
        .iter()
        .map(|coin| Ok(serde_json::json!({ "json": serde_json::to_value(coin)?, "borsh": hex(borsh::to_vec(coin)?), "hash": hex(hash(coin)) })))
        .collect::<anyhow::Result<Vec<_>>>()?;

    let transactions = vec![
        // No inputs and no outputs: the empty transaction.
        Transaction::default(),
        // A transfer with change, from one coin.
        spend(&coins[0..1], vec![value(other, 500_000), value(me, 1_499_000)]),
        // A transfer of everything, from coins of every kind of outpoint.
        spend(&[coins[0].clone(), coins[2].clone(), coins[4].clone()], vec![value(other, 54_999_000)]),
        // A withdrawal request with change.
        spend(&coins[2..3], vec![withdrawal(me, 1_000_000, 2_000, MAIN_ADDRESSES[0]), value(me, 46_997_000)]),
        // Withdrawal requests to every kind of main-chain address.
        spend(&[coins[2].clone(), coins[4].clone()], MAIN_ADDRESSES.iter().enumerate().map(|(i, a)| withdrawal(me, 10_000 * (i as u64 + 1), 500 + i as u64, a)).collect()),
    ];
    let transactions_json = transactions
        .iter()
        .map(|tx| Ok(serde_json::json!({ "json": serde_json::to_value(tx)?, "borsh": hex(tx.canonical_bytes()?), "txid": tx.txid().to_string() })))
        .collect::<anyhow::Result<Vec<_>>>()?;

    // The node's own signatures: each key signs each message.
    let messages: Vec<Vec<u8>> = vec![vec![], b"sidepot".to_vec(), transactions[1].canonical_bytes()?, bytes::<300>("a long message").to_vec()];
    let mut signatures = vec![];
    for (k, (scalar, key)) in keys.iter().enumerate() {
        for (m, message) in messages.iter().enumerate() {
            let verifying_key = VerifyingKey::from(key);
            let signature = key.sign(rng(&format!("nonce {k} {m}")), message);
            let authorization = Authorization { verifying_key, signature };
            let encoded = borsh::to_vec(&authorization)?;
            signatures.push(serde_json::json!({
                "scalar": hex(scalar),
                "message": hex(message),
                "verifyingKey": hex(&encoded[..32]),
                "signature": hex(&encoded[32..]),
                "authorization": serde_json::to_value(&authorization)?,
            }));
        }
    }

    // Whole transactions as the node's wallet signs them, one authorization per input.
    let context = BatchVerificationContext::new(&mut rng("batch"));
    let mut authorized = vec![];
    for (i, tx) in transactions.iter().enumerate().skip(1) {
        let signers: Vec<_> = tx.inputs.iter().map(|_| (me, &keys[0].1)).collect();
        let signed = authorization::authorize(rng(&format!("authorize {i}")), &signers, tx.clone())?;
        authorization::verify_authorized_transaction(&context, &signed)?;
        authorized.push(serde_json::json!({ "json": serde_json::to_value(&signed)?, "address": me.to_string(), "txid": tx.txid().to_string() }));
    }

    // Game deposits (docs/adr/0023): the outputs alone, transactions that make them (with change, beside a
    // transfer, and of a coin's whole value), and the same transactions signed as the node's wallet signs them.
    let deposits = vec![game_deposit(account(0), 1), game_deposit(account(0), 500_000), game_deposit(account(1), u64::MAX), game_deposit(account(2), 2_100_000_000_000_000)];
    let deposits_json = deposits
        .iter()
        .map(|output| Ok(serde_json::json!({ "json": serde_json::to_value(output)?, "borsh": hex(borsh::to_vec(output)?) })))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let deposit_transactions = vec![
        spend(&coins[0..1], vec![game_deposit(account(0), 500_000), value(me, 1_499_000)]),
        spend(&[coins[2].clone(), coins[4].clone()], vec![value(other, 1_000_000), game_deposit(account(1), 2_000_000), value(me, 49_999_000)]),
        spend(&coins[4..5], vec![game_deposit(account(0), 4_999_000)]),
    ];
    let mut deposit_transactions_json = vec![];
    for (i, tx) in deposit_transactions.iter().enumerate() {
        let signers: Vec<_> = tx.inputs.iter().map(|_| (me, &keys[0].1)).collect();
        let signed = authorization::authorize(rng(&format!("authorize game deposit {i}")), &signers, tx.clone())?;
        authorization::verify_authorized_transaction(&context, &signed)?;
        let inputs = tx.inputs.iter().map(|(outpoint, hash)| Ok(serde_json::json!({ "outpoint": serde_json::to_value(outpoint)?, "hash": hex(hash) }))).collect::<anyhow::Result<Vec<_>>>()?;
        deposit_transactions_json.push(serde_json::json!({
            "json": serde_json::to_value(tx)?,
            "borsh": hex(tx.canonical_bytes()?),
            "txid": tx.txid().to_string(),
            "inputs": inputs,
            "authorized": serde_json::to_value(&signed)?,
            "address": me.to_string(),
        }));
    }

    Ok(serde_json::json!({
        "source": "thunder_types (the Sidepot node, branch sidepot), by core/sidepot/thunder-vectors",
        "keys": keys_json,
        "pointedOutputs": coins_json,
        "transactions": transactions_json,
        "signatures": signatures,
        "authorized": authorized,
        "gameDeposits": { "outputs": deposits_json, "transactions": deposit_transactions_json },
    }))
}

/// Checks the wallet's transactions as the node does when it takes one: the JSON parses as the node's
/// `Authorized<Transaction>`, every authorization verifies over the canonical bytes, and each
/// signer's address is the one named.
fn verify(input: &str) -> anyhow::Result<serde_json::Value> {
    let cases: Vec<serde_json::Value> = serde_json::from_str(input).context("expected a JSON list")?;
    let context = BatchVerificationContext::new(&mut rng("batch"));
    let mut checked = vec![];
    for (i, case) in cases.iter().enumerate() {
        let tx: AuthorizedTransaction = serde_json::from_value(case["tx"].clone()).with_context(|| format!("case {i}: not an Authorized<Transaction>"))?;
        let address: Address = case["address"].as_str().ok_or_else(|| anyhow!("case {i}: no address"))?.parse()?;
        ensure!(!tx.transaction.inputs.is_empty(), "case {i}: no inputs");
        authorization::verify_authorized_transaction(&context, &tx).with_context(|| format!("case {i}: the node refuses its authorizations"))?;
        for authorization in &tx.authorizations {
            if get_address(authorization.verifying_key) != address {
                bail!("case {i}: signed by {}, not {address}", get_address(authorization.verifying_key));
            }
        }
        // What the node reads back is what the wallet sent: the same JSON, value for value.
        ensure!(serde_json::to_value(&tx)? == case["tx"], "case {i}: the node writes this transaction differently");
        checked.push(serde_json::json!({
            "tx": case["tx"],
            "address": address.to_string(),
            "borsh": hex(tx.transaction.canonical_bytes()?),
            "txid": tx.transaction.txid().to_string(),
            "fee": case.get("fee"),
            "name": case.get("name"),
        }));
    }
    Ok(serde_json::Value::Array(checked))
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["generate"] => generate()?,
        ["verify"] => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            verify(&input)?
        }
        _ => bail!("usage: thunder-vectors generate | thunder-vectors verify < wallet-signed.json"),
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
