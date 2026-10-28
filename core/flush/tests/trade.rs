//! A trade a `flush:` link asks for, built by the module (docs/adr/0016): one kind-21 marker
//! through the pool (or a route's pools in turn), laid out as Flush's own wallet lays it out (live tx 0f18f338…4e33), the pool
//! proven from its id and the token's decimals from its registration, the floor checked against
//! the node's quote.
mod common;

use std::str::FromStr;

use bitcoin::psbt::Psbt;
use bitcoin::ScriptBuf;
use common::{address, paying, script, tx_hex, FOREIGN, STARTER};
use ecx_flush::bast::{self, transfer_marker};
use ecx_flush::{build_trade, decode, decode_with_evidence, ClearView, Decoded, RefusalCode};
use serde_json::{json, Value};

const FIXTURES: &str = include_str!("trade-fixtures.json");
const NOW: i64 = 1_800_000_000;
const FORK: &str = "6bb2ae6e23e626cd2fba1f8845d8bbc047aeb9a8f4690ee9a21b5d04584dfb03";
const FORK_POOL: &str = "2b16f8c06c0f98034bacfe23cec9e36ce96b3d1282766dd957901435354b402a";
const BROSEVELT: &str = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
/// BROSEVELT's concentrated pool with ECX: a route's second pool after FORK's.
const BROSEVELT_POOL: &str = "2a1dbe3c10bc5781a59dd40e2f516dab62b1d15170c8788a7a5c87a4076cc7a9";
/// 1 sat/vB.
const FEE_RATE: u64 = 1000;

fn fixtures() -> Value {
    serde_json::from_str(FIXTURES).unwrap()
}

fn ecx_coin(seed: u8, sats: u64) -> Value {
    json!({ "tx": tx_hex(&paying(seed, &[(&script(STARTER, 0, 1), sats)])), "vout": 0, "chain": 0, "index": 1 })
}

fn fork_coin(seed: u8, units: u64) -> Value {
    let marker = ScriptBuf::from_bytes(transfer_marker(&[(0, FORK, units)]).unwrap());
    json!({ "tx": tx_hex(&paying(seed, &[(&script(STARTER, 0, 0), 0), (&marker, 0)])), "vout": 0, "chain": 0, "index": 0 })
}

fn link(verb: &str, params: &str) -> String {
    format!("flush:{verb}?v=1&network=ecashbeta&exp={}&{params}", NOW + 600)
}

fn buy(ecx: &str, min_tokens: &str) -> String {
    link("buy", &format!("launch=FORK&asset={FORK}&ecx={ecx}&min_tokens={min_tokens}"))
}

/// A trade of `link`, with FORK's live pool and registration, `quote` the node's, and `coins`.
fn order(link: &str, quote: f64, coins: Vec<Value>) -> Value {
    let f = fixtures();
    json!({
        "link": link, "now": NOW, "pools": [f["forkPool"]], "registrations": [f["forkRegistration"]["hex"]],
        "quote": quote, "minPayout": 0.00005, "coins": coins, "feeRate": FEE_RATE, "changeIndex": 2,
    })
}

fn built(order: &Value) -> (Psbt, String) {
    let built = build_trade(&order.to_string(), STARTER).unwrap();
    (Psbt::from_str(&built.pset).unwrap(), built.burn)
}

fn refused(order: &Value) -> (RefusalCode, String) {
    let refusal = build_trade(&order.to_string(), STARTER).expect_err("refused");
    (refusal.code, refusal.message)
}

#[test]
fn a_launch_buy_is_laid_out_as_flushs_wallet_lays_it_out() {
    let (psbt, burn) = built(&order(&buy("0.0001", "0.044"), 0.044482, vec![ecx_coin(1, 100_000)]));
    let tx = &psbt.unsigned_tx;
    let given_out = script(STARTER, 0, 0);
    assert_eq!(tx.output.len(), 3);
    // The result, at the address the site knows.
    assert_eq!((tx.output[0].value.to_sat(), &tx.output[0].script_pubkey), (0, &given_out));
    // The marker, carrying the ECX paid in.
    assert_eq!(tx.output[1].value.to_sat(), 10_000);
    assert_eq!(burn, "10000");
    let marker = bast::parse(tx.output[1].script_pubkey.as_bytes()).unwrap().to_json();
    assert_eq!(
        marker["fields"],
        json!({ "asset_in": "00".repeat(32), "pools": [FORK_POOL], "amount_in": 10_000, "min_out": 44_000, "chn_to": given_out.to_hex_string() })
    );
    assert_eq!(marker["outputs"], json!([{ "n": 0, "carries": "result" }]));
    // ECX change, to the change address.
    assert_eq!(tx.output[2].script_pubkey, script(STARTER, 1, 2));
    assert!(tx.output[2].value.to_sat() > 89_000);
    assert_eq!(psbt.inputs.len(), 1);
}

#[test]
fn a_sale_spends_the_tokens_and_lists_their_change_first() {
    let sell = link("sell", &format!("launch=FORK&asset={FORK}&tokens=0.05&min_ecx=0.0001"));
    let (psbt, burn) = built(&order(&sell, 0.00011, vec![fork_coin(1, 80_000), ecx_coin(2, 20_000)]));
    let tx = &psbt.unsigned_tx;
    let given_out = script(STARTER, 0, 0);
    assert_eq!(burn, "0");
    assert_eq!(tx.output[1].value.to_sat(), 0, "nothing ECX goes in");
    let marker = bast::parse(tx.output[2].script_pubkey.as_bytes()).unwrap().to_json();
    assert_eq!(marker["fields"]["asset_in"], FORK);
    assert_eq!((marker["fields"]["amount_in"].as_u64(), marker["fields"]["min_out"].as_u64()), (Some(50_000), Some(10_000)));
    assert_eq!(marker["outputs"], json!([{ "n": 0, "carries": "asset", "id": FORK, "amount": 30_000 }, { "n": 1, "carries": "result" }]));
    assert_eq!((&tx.output[0].script_pubkey, &tx.output[1].script_pubkey), (&given_out, &given_out));
    assert_eq!(psbt.inputs.len(), 2, "the FORK coin, and ECX for the fee");
}

#[test]
fn a_swap_through_the_links_pool_builds_the_same_marker() {
    let swap = link("swap", &format!("pool={FORK_POOL}&from=ECX&to=FORK&amount=0.0001&min_out=0.044"));
    let (psbt, _) = built(&order(&swap, 0.044482, vec![ecx_coin(1, 100_000)]));
    let marker = bast::parse(psbt.unsigned_tx.output[1].script_pubkey.as_bytes()).unwrap().to_json();
    assert_eq!(marker["fields"]["pools"], json!([FORK_POOL]));
    assert_eq!(marker["fields"]["min_out"], 44_000);
}

#[test]
fn a_floor_finer_than_the_tokens_places_is_rounded_up() {
    let (psbt, _) = built(&order(&buy("0.0001", "0.0440001"), 0.044482, vec![ecx_coin(1, 100_000)]));
    let marker = bast::parse(psbt.unsigned_tx.output[1].script_pubkey.as_bytes()).unwrap().to_json();
    assert_eq!(marker["fields"]["min_out"], 44_001);
}

#[test]
fn what_the_wallet_cant_prove_or_wouldnt_mean_is_refused() {
    let coins = || vec![ecx_coin(1, 100_000)];
    let with = |mut order: Value, key: &str, value: Value| {
        order[key] = value;
        order
    };
    let mut other_fee = fixtures()["forkPool"].clone();
    other_fee["fee_millionths"] = json!(3000);
    let mut abandoned = fixtures()["forkPool"].clone();
    abandoned["abandoned"] = json!(true);
    let cases: Vec<(&str, Value)> = vec![
        (
            "a swap's pool whose kind isn't what makes the link's id",
            with(order(&link("swap", &format!("pool={FORK_POOL}&from=ECX&to=FORK&amount=0.0001&min_out=0.044")), 0.044482, coins()), "pools", json!([other_fee])),
        ),
        ("an abandoned pool", with(order(&buy("0.0001", "0.044"), 0.044482, coins()), "pools", json!([abandoned]))),
        ("no registration of FORK", with(order(&buy("0.0001", "0.044"), 0.044482, coins()), "registrations", json!([]))),
        (
            "another launch's ticker",
            order(&link("buy", &format!("launch=CORN&asset={FORK}&ecx=0.0001&min_tokens=0.044")), 0.044482, coins()),
        ),
        (
            "a swap naming another pool",
            order(&link("swap", &format!("pool={}&from=ECX&to=FORK&amount=0.0001&min_out=0.044", "ab".repeat(32))), 0.044482, coins()),
        ),
        ("a floor more than 10% below the quote", order(&buy("0.0001", "0.04"), 0.044482, coins())),
        ("a floor the pool can't meet now", order(&buy("0.0001", "0.045"), 0.044482, coins())),
        ("less ECX in than the node pays out", order(&buy("0.00004", "0.017"), 0.0178, coins())),
        ("more places than FORK has", order(&link("sell", &format!("launch=FORK&asset={FORK}&tokens=0.0000001&min_ecx=0.0001")), 0.0001, coins())),
        ("an expired link", with(order(&buy("0.0001", "0.044"), 0.044482, coins()), "now", json!(NOW + 3600))),
    ];
    for (what, order) in cases {
        let (code, message) = refused(&order);
        assert_eq!(code, RefusalCode::InvalidAction, "{what}: {message}");
    }
    let sell_floor = link("sell", &format!("launch=FORK&asset={FORK}&tokens=0.05&min_ecx=0.00001"));
    assert_eq!(refused(&order(&sell_floor, 0.000011, vec![fork_coin(1, 80_000), ecx_coin(2, 20_000)])).0, RefusalCode::InvalidAction, "ECX out below the payout");
    assert_eq!(refused(&order(&link("deposit", "pool=x"), 0.0, coins())).0, RefusalCode::UnsupportedAction);
    assert_eq!(refused(&order(&buy("0.0001", "0.044"), 0.044482, vec![ecx_coin(1, 5_000)])).0, RefusalCode::InsufficientFunds);
}

/// `psbt` decoded with `evidence`.
fn decoded(psbt: &Psbt, evidence: &Value) -> Decoded {
    decode_with_evidence(&psbt.to_string(), STARTER, &evidence.to_string()).unwrap()
}

fn clear(psbt: &Psbt) -> ClearView {
    match decoded(psbt, &json!({ "pool": fixtures()["forkPool"] })) {
        Decoded::Clear { view } => view,
        blind => panic!("expected a Clear View, got {blind:?}"),
    }
}

fn blind_reason(decoded: Decoded) -> String {
    match decoded {
        Decoded::Blind { reason, .. } => reason,
        clear => panic!("expected Blind, got {clear:?}"),
    }
}

#[test]
fn a_built_buy_decodes_clear_with_its_pool_as_evidence() {
    let (psbt, _) = built(&order(&buy("0.0001", "0.044"), 0.044482, vec![ecx_coin(1, 100_000)]));
    let view = serde_json::to_value(clear(&psbt)).unwrap();
    let given_out = address(STARTER, 0, 0);
    assert_eq!(
        view["trade"],
        json!({
            "pools": [FORK_POOL], "assetIn": "", "amountIn": "10000", "via": [], "assetOut": FORK, "minOut": "44000", "result": 0,
            "payout": { "kind": "address", "address": given_out, "yours": true }, "warnings": [],
        })
    );
    // The result reads as at least the floor, at the address the site knows; the marker isn't an output.
    assert_eq!(view["outputs"][0], json!({ "index": 0, "asset": FORK, "amount": "44000", "atLeast": true, "destination": { "kind": "address", "address": given_out, "yours": true } }));
    assert_eq!(view["outputs"].as_array().unwrap().len(), 2, "the result and the ECX change");
    assert_eq!(view["outputs"][1]["index"], 2);
}

#[test]
fn a_built_sale_decodes_clear_with_its_token_change() {
    let sell = link("sell", &format!("launch=FORK&asset={FORK}&tokens=0.05&min_ecx=0.0001"));
    let (psbt, _) = built(&order(&sell, 0.00011, vec![fork_coin(1, 80_000), ecx_coin(2, 20_000)]));
    let view = serde_json::to_value(clear(&psbt)).unwrap();
    assert_eq!((&view["trade"]["assetIn"], &view["trade"]["amountIn"], &view["trade"]["assetOut"]), (&json!(FORK), &json!("50000"), &json!("")));
    assert_eq!(view["outputs"][0]["asset"], FORK);
    assert_eq!(view["outputs"][0]["amount"], "30000");
    assert_eq!(view["outputs"][1]["atLeast"], true);
    assert_eq!(view["outputs"][1]["amount"], "10000");
    assert_eq!(view["inputs"][0]["asset"], FORK);
}

#[test]
fn a_trade_without_its_pool_is_blind_and_with_another_pools_is_refused() {
    let (psbt, _) = built(&order(&buy("0.0001", "0.044"), 0.044482, vec![ecx_coin(1, 100_000)]));
    assert!(blind_reason(decode(&psbt.to_string(), STARTER).unwrap()).contains("swap pools"));
    let mut other = fixtures()["forkPool"].clone();
    other["fee_millionths"] = json!(3000);
    let refusal = decode_with_evidence(&psbt.to_string(), STARTER, &json!({ "pool": other }).to_string()).unwrap_err();
    assert_eq!(refusal.code, RefusalCode::InvalidEvidence, "{}", refusal.message);
}

#[test]
fn a_trade_paying_its_result_elsewhere_is_clear_and_warns() {
    let (mut psbt, _) = built(&order(&buy("0.0001", "0.044"), 0.044482, vec![ecx_coin(1, 100_000)]));
    // As a site might build it: the result and the ECX back to someone else.
    let foreign = script(FOREIGN, 0, 0);
    psbt.unsigned_tx.output[0].script_pubkey = foreign.clone();
    psbt.outputs[0] = Default::default();
    let marker = bast::swap_pools_marker(&"00".repeat(32), &[FORK_POOL], 10_000, 44_000, foreign.as_bytes(), &[(0, None)]).unwrap();
    psbt.unsigned_tx.output[1].script_pubkey = ScriptBuf::from_bytes(marker);
    let view = serde_json::to_value(clear(&psbt)).unwrap();
    assert_eq!(view["outputs"][0]["destination"]["yours"], false);
    assert_eq!(view["trade"]["payout"]["yours"], false);
    assert_eq!(view["trade"]["warnings"].as_array().unwrap().len(), 2, "{}", view["trade"]["warnings"]);
}

#[test]
fn a_trade_the_decoder_cant_fully_check_is_blind() {
    let (base, _) = built(&order(&buy("0.0001", "0.044"), 0.044482, vec![ecx_coin(1, 100_000)]));
    let evidence = json!({ "pool": fixtures()["forkPool"] });
    // The marker holds other than the ECX it pays in.
    let mut psbt = base.clone();
    psbt.unsigned_tx.output[1].value = bitcoin::Amount::from_sat(9_000);
    psbt.unsigned_tx.output[2].value += bitcoin::Amount::from_sat(1_000);
    assert!(blind_reason(decoded(&psbt, &evidence)).contains("ECX"));
    // A route back to where it started: ECX through FORK's pool and back again.
    let mut psbt = base.clone();
    let route = bast::swap_pools_marker(&"00".repeat(32), &[FORK_POOL, FORK_POOL], 10_000, 44_000, &[], &[(0, None)]).unwrap();
    psbt.unsigned_tx.output[1].script_pubkey = ScriptBuf::from_bytes(route);
    let both = json!({ "pools": [fixtures()["forkPool"], fixtures()["forkPool"]] });
    assert!(blind_reason(decoded(&psbt, &both)).contains("comes back"));
    // Two pools described by one: the evidence doesn't check out.
    assert_eq!(decode_with_evidence(&psbt.to_string(), STARTER, &evidence.to_string()).unwrap_err().code, RefusalCode::InvalidEvidence);
}

/// A route of FORK through ECX to BROSEVELT, as flush.markets links it: both pools and both registrations.
fn route_order(pools: &str, quote: f64) -> Value {
    let f = fixtures();
    let mut order = order(
        &link("route", &format!("pools={pools}&from=FORK&to=BROSEVELT&amount=0.05&min_out=12.3")),
        quote,
        vec![fork_coin(1, 80_000), ecx_coin(2, 20_000)],
    );
    order["pools"] = json!([f["forkPool"], f["brosevelt"]["pool"]]);
    order["registrations"] = json!([f["forkRegistration"]["hex"], f["brosevelt"]["registration"]["hex"]]);
    order
}

#[test]
fn a_route_builds_one_marker_through_its_pools_in_turn() {
    let order = route_order(&format!("{FORK_POOL}%2C{BROSEVELT_POOL}"), 12.34);
    let built = build_trade(&order.to_string(), STARTER).unwrap();
    let psbt = Psbt::from_str(&built.pset).unwrap();
    let tx = &psbt.unsigned_tx;
    let given_out = script(STARTER, 0, 0);
    // FORK's change, then the result, both at the address the site knows; then the marker, holding no ECX.
    assert_eq!((&tx.output[0].script_pubkey, &tx.output[1].script_pubkey), (&given_out, &given_out));
    assert_eq!((tx.output[2].value.to_sat(), built.burn.as_str()), (0, "0"));
    let marker = bast::parse(tx.output[2].script_pubkey.as_bytes()).unwrap().to_json();
    assert_eq!(marker["fields"], json!({ "asset_in": FORK, "pools": [FORK_POOL, BROSEVELT_POOL], "amount_in": 50_000, "min_out": 1_230, "chn_to": "" }));
    assert_eq!(marker["outputs"], json!([{ "n": 0, "carries": "asset", "id": FORK, "amount": 30_000 }, { "n": 1, "carries": "result" }]));
    let trade = serde_json::to_value(&built.trade).unwrap();
    assert_eq!((&trade["verb"], &trade["pools"], &trade["via"][0]["ticker"], &trade["assetOut"]["ticker"]), (&json!("route"), &json!([FORK_POOL, BROSEVELT_POOL]), &json!("ECX"), &json!("BROSEVELT")));
    assert_eq!((&trade["minOut"], &trade["quote"]), (&json!("1230"), &json!("1234")));

    // Clear, with each pool as evidence: the path is the Decoder's own walk.
    let f = fixtures();
    let view = match decoded(&psbt, &json!({ "pools": [f["forkPool"], f["brosevelt"]["pool"]] })) {
        Decoded::Clear { view } => serde_json::to_value(view).unwrap(),
        blind => panic!("expected a Clear View, got {blind:?}"),
    };
    assert_eq!(
        view["trade"],
        json!({
            "pools": [FORK_POOL, BROSEVELT_POOL], "assetIn": FORK, "amountIn": "50000", "via": [""], "assetOut": BROSEVELT, "minOut": "1230",
            "result": 1, "payout": null, "warnings": [],
        })
    );
    // The pools described in the other order don't follow from FORK: refused.
    let swapped = json!({ "pools": [f["brosevelt"]["pool"], f["forkPool"]] });
    assert_eq!(decode_with_evidence(&psbt.to_string(), STARTER, &swapped.to_string()).unwrap_err().code, RefusalCode::InvalidEvidence);
}

#[test]
fn a_route_whose_pools_dont_lead_from_its_from_to_its_to_is_refused() {
    let f = fixtures();
    let swapped = |mut order: Value| {
        order["pools"] = json!([f["brosevelt"]["pool"], f["forkPool"]]);
        order
    };
    let one_pool = |mut order: Value| {
        order["pools"] = json!([f["forkPool"]]);
        order
    };
    let cases: Vec<(&str, Value)> = vec![
        ("pools in the other order", swapped(route_order(&format!("{BROSEVELT_POOL}%2C{FORK_POOL}"), 12.34))),
        ("a pool described that isn't the link's", swapped(route_order(&format!("{FORK_POOL}%2C{BROSEVELT_POOL}"), 12.34))),
        ("fewer pools described than the link names", one_pool(route_order(&format!("{FORK_POOL}%2C{BROSEVELT_POOL}"), 12.34))),
        ("a floor the route can't meet now", route_order(&format!("{FORK_POOL}%2C{BROSEVELT_POOL}"), 12.29)),
        ("a floor more than 10% below the route's quote", route_order(&format!("{FORK_POOL}%2C{BROSEVELT_POOL}"), 14.0)),
    ];
    for (what, order) in cases {
        let (code, message) = refused(&order);
        assert_eq!(code, RefusalCode::InvalidAction, "{what}: {message}");
    }
    let mut ends_elsewhere = route_order(&format!("{FORK_POOL}%2C{BROSEVELT_POOL}"), 12.34);
    ends_elsewhere["link"] = json!(link("route", &format!("pools={FORK_POOL}%2C{BROSEVELT_POOL}&from=FORK&to=SOON&amount=0.05&min_out=12.3")));
    assert!(refused(&ends_elsewhere).1.contains("ends in"));
}
