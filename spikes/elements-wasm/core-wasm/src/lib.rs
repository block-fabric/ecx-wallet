//! Thin wasm-bindgen adapter over `spike-core`. All logic lives in `core`.
use wasm_bindgen::prelude::*;

fn js(e: String) -> JsError {
    JsError::new(&e)
}

#[wasm_bindgen(js_name = starterMnemonic)]
pub fn starter_mnemonic(master: &str, passphrase: &str, slot: u32) -> Result<String, JsError> {
    spike_core::starter_mnemonic(master, passphrase, slot).map_err(js)
}

#[wasm_bindgen]
pub struct Core(spike_core::Core);

#[wasm_bindgen]
impl Core {
    #[wasm_bindgen(constructor)]
    pub fn new(
        starter: &str,
        policy_asset: &str,
        genesis_hash: &str,
        parent_genesis_hash: &str,
    ) -> Result<Core, JsError> {
        let net = spike_core::NetworkConfig {
            policy_asset: policy_asset.into(),
            genesis_hash: genesis_hash.into(),
            parent_genesis_hash: parent_genesis_hash.into(),
        };
        spike_core::Core::new(starter, &net).map(Core).map_err(js)
    }

    pub fn descriptor(&self) -> String {
        self.0.descriptor()
    }

    pub fn address(&self, index: u32) -> Result<String, JsError> {
        self.0.address(index).map_err(js)
    }

    #[wasm_bindgen(js_name = makeTestPset)]
    pub fn make_test_pset(&self, rng_seed: &[u8]) -> Result<String, JsError> {
        let seed: [u8; 32] = rng_seed
            .try_into()
            .map_err(|_| JsError::new("seed must be 32 bytes"))?;
        self.0.make_test_pset(seed).map_err(js)
    }

    /// Returns the signed base64 PSET.
    #[wasm_bindgen(js_name = signPset)]
    pub fn sign_pset(&self, pset: &str) -> Result<String, JsError> {
        let (signed, n) = self.0.sign_pset(pset).map_err(js)?;
        if n == 0 {
            return Err(JsError::new("no signatures added"));
        }
        Ok(signed)
    }

    #[wasm_bindgen(js_name = psetDetails)]
    pub fn pset_details(&self, pset: &str) -> Result<String, JsError> {
        self.0.pset_details(pset).map_err(js)
    }
}
