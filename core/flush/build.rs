// Picks the Chain Entry the module embeds: `chain-entry.json`, or the file named by
// `$ECX_FLUSH_CHAIN_ENTRY` (the e2e build's, from e2e/scripts/build.mjs).
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=ECX_FLUSH_CHAIN_ENTRY");
    let path = match env::var_os("ECX_FLUSH_CHAIN_ENTRY") {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("chain-entry.json"),
    };
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rustc-env=ECX_FLUSH_CHAIN_ENTRY_PATH={}", path.display());
}
