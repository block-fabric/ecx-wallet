// Picks the Chain Entry the module embeds: `chain-entry.json`, or the file named by
// `$ECX_SIDEPOT_CHAIN_ENTRY`.
use std::env;
use std::path::PathBuf;

fn main() {
    // The network the module serves: `$ECX_NETWORK`. Unset (as for `cargo test`), mainnet, the one
    // network Sidepot's Chain Entry names and every fixture of its tests is of: the other modules
    // default to betanet, where Sidepot has no chain (core/scripts/build.mjs bundles it for mainnet only).
    println!("cargo:rerun-if-env-changed=ECX_NETWORK");
    let network = env::var("ECX_NETWORK").unwrap_or_else(|_| "mainnet".into());
    println!("cargo:rustc-env=ECX_NETWORK={network}");
    println!("cargo:rerun-if-env-changed=ECX_SIDEPOT_CHAIN_ENTRY");
    let path = match env::var_os("ECX_SIDEPOT_CHAIN_ENTRY") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("chain-entry.json"),
    };
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rustc-env=ECX_SIDEPOT_CHAIN_ENTRY_PATH={}", path.display());
}
