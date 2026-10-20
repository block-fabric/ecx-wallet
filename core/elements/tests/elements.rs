//! Seam 2: the Elements Chain Module, through its public interface only.
//!
//! Address fixtures were computed independently of this crate, in the LWK 0.19.0 probe used for
//! the spec's research notes, from the Slot 24 Starter of "abandon … about" with no passphrase
//! (itself a BitWindow `DeriveStarter` vector, see core/vault/tests/vault.rs).
use ecx_elements::{declare, derive_account};

/// The Slot 24 Starter of "abandon … about", no passphrase.
const STARTER: &str = "buyer citizen congress doll secret merry denial law live wait pass drive";

#[test]
fn the_slot_24_starter_derives_lwk_standard_wpkh_receive_addresses_in_elements_encoding() {
    let account = derive_account(STARTER, 2).unwrap();
    let addresses: Vec<_> = account.receive.iter().map(|a| (a.index, a.address.as_str())).collect();
    assert_eq!(
        addresses,
        vec![
            (0, "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm"),
            (1, "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn"),
        ]
    );
}

#[test]
fn the_watch_data_is_the_explicit_wpkh_descriptor_on_lwks_non_mainnet_default_path() {
    let account = derive_account(STARTER, 1).unwrap();
    assert_eq!(
        account.descriptor,
        "elwpkh([3b27f87d/84h/1h/0h]tpubDDL3PFxTGwYoTxQHpMfqnwzdZoPHtAxpSnXWkQAfV1eQutNJss45qjiXwTYwzNfmi1a63E4M3Q4v4FPw2xzf4ztGDanQJqndsAAYVRnYixi/<0;1>/*)"
    );
}

#[test]
fn a_different_starter_derives_different_addresses() {
    let other = derive_account("blush cream bullet drive index disease noble east target dice put rate", 1).unwrap();
    assert_ne!(other.receive[0].address, "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm");
    assert!(other.receive[0].address.starts_with("elements1q"));
}

#[test]
fn something_that_is_not_a_starter_is_refused() {
    assert!(derive_account("not a mnemonic", 1).is_err());
}

#[test]
fn declare_reports_the_betanet_slot_24_binding_for_psets() {
    let d = declare();
    assert_eq!(d.binding.chain, "ecash:betanet-s24");
    assert_eq!(d.binding.format, "pset");
    assert_eq!(d.binding.payload_versions, vec!["1".to_string()]);
    assert!(d.capabilities.is_empty());
}
