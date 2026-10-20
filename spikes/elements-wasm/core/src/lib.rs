//! Throwaway spike: a pure-Rust Elements signing core (no wasm-bindgen here).
//!
//! - `starter_mnemonic`: BitWindow-style per-Slot Starter (m/44'/0'/<slot>' -> SHA256(0x00||k)[:16] -> 12 words)
//! - `Core::new`: LWK SwSigner on the Starter, wpkh + SLIP-77 CT descriptor, CustomElements network
//! - `Core::address`: confidential address at index i
//! - `Core::make_test_pset`: builds + blinds a 1-in/2-out PSET spending a fake explicit UTXO we own
//!   (stands in for what a Sidechain Server would send)
//! - `Core::sign_pset`: LWK software signer over a base64 PSET
//! - `Core::pset_details`: LWK PsetDetails (Clear Signing base: balances, fee)

use std::collections::HashMap;
use std::str::FromStr;

use lwk_common::{ElementsParamsBuilder, Network, Signer};
use lwk_signer::SwSigner;
use lwk_wollet::elements::bitcoin::bip32::{ChildNumber, DerivationPath, Xpriv};
use lwk_wollet::elements::bitcoin::hashes::{sha256, Hash};
use lwk_wollet::elements::bitcoin::{self, NetworkKind};
use lwk_wollet::elements::confidential::{AssetBlindingFactor, ValueBlindingFactor};
use lwk_wollet::elements::pset::{Input, Output, PartiallySignedTransaction};
use lwk_wollet::elements::{
    AssetId, BlockHash, OutPoint, Script, TxOut, TxOutSecrets, Txid,
};
use lwk_wollet::elements_miniscript::{ForEachKey, ToPublicKey};
use lwk_wollet::{Chain, Wollet, WolletDescriptor, EC};

pub type Error = String;

fn e<E: std::fmt::Debug>(x: E) -> String {
    format!("{x:?}")
}

/// BitWindow-compatible Starter for `slot`, from the Master Mnemonic (empty passphrase on the starter).
pub fn starter_mnemonic(master: &str, passphrase: &str, slot: u32) -> Result<String, Error> {
    let m = bip39::Mnemonic::parse(master).map_err(e)?;
    let seed = m.to_seed(passphrase);
    let xprv = Xpriv::new_master(NetworkKind::Main, &seed).map_err(e)?;
    let path: DerivationPath = vec![
        ChildNumber::from_hardened_idx(44).map_err(e)?,
        ChildNumber::from_hardened_idx(0).map_err(e)?,
        ChildNumber::from_hardened_idx(slot).map_err(e)?,
    ]
    .into();
    let k = xprv.derive_priv(&EC, &path).map_err(e)?;
    let mut buf = vec![0u8];
    buf.extend_from_slice(&k.private_key.secret_bytes());
    let h = sha256::Hash::hash(&buf);
    let words = bip39::Mnemonic::from_entropy(&h.to_byte_array()[..16]).map_err(e)?;
    Ok(words.to_string())
}

pub struct NetworkConfig {
    pub policy_asset: String,
    pub genesis_hash: String,
    pub parent_genesis_hash: String,
}

pub struct Core {
    signer: SwSigner,
    network: Network,
    desc: WolletDescriptor,
}

impl Core {
    /// `starter`: the Slot's Starter mnemonic (the signer never sees the Master Mnemonic).
    pub fn new(starter: &str, net: &NetworkConfig) -> Result<Self, Error> {
        let params = ElementsParamsBuilder::new()
            .with_policy_asset(AssetId::from_str(&net.policy_asset).map_err(e)?)
            .with_genesis_hash(BlockHash::from_str(&net.genesis_hash).map_err(e)?)
            .with_parent_genesis_hash(
                bitcoin::BlockHash::from_str(&net.parent_genesis_hash).map_err(e)?,
            )
            .build()
            .map_err(e)?;
        let network = Network::CustomElements(params);
        let signer = SwSigner::new(starter, false).map_err(e)?;
        let desc_str = signer.wpkh_slip77_descriptor()?;
        let desc = WolletDescriptor::from_str(&desc_str).map_err(e)?;
        Ok(Core { signer, network, desc })
    }

    pub fn descriptor(&self) -> String {
        self.desc.to_string()
    }

    pub fn address(&self, index: u32) -> Result<String, Error> {
        Ok(self
            .desc
            .address(index, self.network.address_params())
            .map_err(e)?
            .to_string())
    }

    /// Build and blind a PSET: input = fake explicit UTXO paying our address 0;
    /// outputs = confidential payment to our address 1 + explicit fee.
    /// `rng_seed` keeps the core free of getrandom.
    pub fn make_test_pset(&self, rng_seed: [u8; 32]) -> Result<String, Error> {
        use rand_chacha::rand_core::SeedableRng;
        let mut rng = rand_chacha::ChaCha20Rng::from_seed(rng_seed);
        let policy = *self.network.policy_asset();
        let spk0 = self.desc.script_pubkey(Chain::External, 0).map_err(e)?;
        let in_value = 100_000u64;
        let fee = 500u64;

        // The fake prevout is itself confidential (paid to our address 0), like a real CT UTXO.
        let addr0 = self
            .desc
            .address(0, self.network.address_params())
            .map_err(e)?;
        let fake_funding = [TxOutSecrets::new(
            policy,
            AssetBlindingFactor::zero(),
            in_value,
            ValueBlindingFactor::zero(),
        )];
        let (prev, in_abf, _in_vbf, _) = TxOut::new_not_last_confidential(
            &mut rng,
            &EC,
            in_value,
            addr0,
            policy,
            &fake_funding,
        )
        .map_err(e)?;
        debug_assert_eq!(prev.script_pubkey, spk0);
        // Recover the input secrets the way a wallet would: unblind with our SLIP-77 key.
        let in_secrets = {
            let bk = self
                .desc
                .ct_descriptor()
                .map_err(e)?
                .key
                .clone();
            let sk = match bk {
                lwk_wollet::elements_miniscript::confidential::Key::Slip77(k) => {
                    k.blinding_private_key(&prev.script_pubkey)
                }
                _ => return Err("expected slip77".into()),
            };
            prev.unblind(&EC, sk).map_err(e)?
        };
        let _ = in_abf;
        let mut pset = PartiallySignedTransaction::new_v2();
        let mut inp = Input::from_prevout(OutPoint::new(Txid::all_zeros(), 0));
        inp.in_utxo_rangeproof = prev.witness.rangeproof.clone();
        inp.witness_utxo = Some(prev);
        // BIP32 derivation so the signer recognises the input as its own.
        let def = self
            .desc
            .definite_descriptor(Chain::External, 0)
            .map_err(e)?;
        def.for_each_key(|k| {
            if let Some((fp, path)) = k.full_derivation_path().map(|p| (k.master_fingerprint(), p)) {
                inp.bip32_derivation.insert(k.to_public_key(), (fp, path));
            }
            true
        });
        pset.add_input(inp);

        let addr1 = self
            .desc
            .address(1, self.network.address_params())
            .map_err(e)?;
        let mut out = Output::new_explicit(
            addr1.script_pubkey(),
            in_value - fee,
            policy,
            addr1.blinding_pubkey.map(bitcoin::PublicKey::new),
        );
        out.blinder_index = Some(0);
        pset.add_output(out);
        pset.add_output(Output::new_explicit(Script::new(), fee, policy, None));
        lwk_common::set_genesis_hash(&mut pset, &self.network);

        let mut secrets = HashMap::new();
        secrets.insert(0usize, in_secrets);
        pset.blind_last(&mut rng, &EC, &secrets).map_err(e)?;
        Ok(pset.to_string())
    }

    /// Sign every input we own; returns (signed base64 PSET, signatures added).
    pub fn sign_pset(&self, pset_b64: &str) -> Result<(String, u32), Error> {
        let mut pset = PartiallySignedTransaction::from_str(pset_b64).map_err(e)?;
        let n = self.signer.sign(&mut pset).map_err(e)?;
        Ok((pset.to_string(), n))
    }

    /// LWK's PsetDetails (what a Decoder would start from): balance per asset + fee.
    pub fn pset_details(&self, pset_b64: &str) -> Result<String, Error> {
        let pset = PartiallySignedTransaction::from_str(pset_b64).map_err(e)?;
        let w = Wollet::without_persist(self.network.clone(), self.desc.clone()).map_err(e)?;
        let d = w.get_details(&pset).map_err(e)?;
        Ok(format!("{:?}", d.balance()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    pub fn net() -> NetworkConfig {
        NetworkConfig {
            policy_asset: "5ac9f65c0efcc4775e0baec4ec03abdde22473cd3cf33c0419ca290e0751b225".into(),
            genesis_hash: "c1b16ae24f2423aea2ea34552292793b5b5e82999ff1a5cc4f7c1a1a6c0b1a2b".into(),
            parent_genesis_hash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f".into(),
        }
    }

    #[test]
    fn end_to_end() {
        let st = starter_mnemonic(MASTER, "", 24).unwrap();
        println!("starter: {st}");
        let c = Core::new(&st, &net()).unwrap();
        println!("addr0: {}", c.address(0).unwrap());
        let p = c.make_test_pset([7; 32]).unwrap();
        println!("details: {}", c.pset_details(&p).unwrap());
        let (_, n) = c.sign_pset(&p).unwrap();
        assert_eq!(n, 1);
    }
}
