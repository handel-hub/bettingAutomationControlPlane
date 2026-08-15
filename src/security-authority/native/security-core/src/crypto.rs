use napi::{Error, Result, Status};
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce, Key
};
use ed25519_dalek::{VerifyingKey, Signature, Verifier, SigningKey, Signer};
use hkdf::Hkdf;
use sha2::Sha256;
use rand::RngCore;

use crate::os_secret::get_root_key;

fn derive_db_key() -> Result<[u8; 32]> {
    let root_key = get_root_key()?;
    let hk = Hkdf::<Sha256>::new(None, &root_key);
    let mut okm = [0u8; 32];
    hk.expand(b"DB_ENCRYPTION", &mut okm).map_err(|_| {
        Error::new(Status::GenericFailure, "HKDF failed".to_string())
    })?;
    Ok(okm)
}

pub fn encrypt(plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let key_bytes = derive_db_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits; 12 bytes
    
    let payload = aes_gcm::aead::Payload {
        msg: plaintext,
        aad,
    };
    
    let mut ciphertext = cipher.encrypt(&nonce, payload).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Encryption failed: {}", e))
    })?;
    
    // Prepend nonce to ciphertext
    let mut result = nonce.to_vec();
    result.append(&mut ciphertext);
    
    Ok(result)
}

pub fn decrypt(ciphertext_with_nonce: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if ciphertext_with_nonce.len() < 12 {
        return Err(Error::new(Status::InvalidArg, "Ciphertext too short".to_string()));
    }
    
    let key_bytes = derive_db_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    
    let (nonce_bytes, ciphertext) = ciphertext_with_nonce.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    
    let payload = aes_gcm::aead::Payload {
        msg: ciphertext,
        aad,
    };
    
    cipher.decrypt(nonce, payload).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Decryption failed: {}", e))
    })
}

pub fn verify_signature(public_key: &[u8], message: &[u8], signature_bytes: &[u8]) -> Result<bool> {
    if public_key.len() != 32 || signature_bytes.len() != 64 {
        return Ok(false);
    }
    
    let mut pub_key_bytes = [0u8; 32];
    pub_key_bytes.copy_from_slice(public_key);
    let pub_key = match VerifyingKey::from_bytes(&pub_key_bytes) {
        Ok(k) => k,
        Err(_) => return Ok(false),
    };
    
    let mut sig_bytes = [0u8; 64];
    sig_bytes.copy_from_slice(signature_bytes);
    let signature = Signature::from_bytes(&sig_bytes);
    
    Ok(pub_key.verify(message, &signature).is_ok())
}

pub fn random_bytes(length: usize) -> Result<Vec<u8>> {
    let mut buf = vec![0u8; length];
    rand::thread_rng().fill_bytes(&mut buf);
    Ok(buf)
}

pub fn raw_encrypt_aead(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if key.len() != 32 {
        return Err(Error::new(Status::InvalidArg, "AES key must be exactly 32 bytes".to_string()));
    }
    let key_slice = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key_slice);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits; 12 bytes
    
    let payload = aes_gcm::aead::Payload {
        msg: plaintext,
        aad: &[],
    };
    
    let mut ciphertext = cipher.encrypt(&nonce, payload).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Encryption failed: {}", e))
    })?;
    
    // Prepend nonce to ciphertext
    let mut result = nonce.to_vec();
    result.append(&mut ciphertext);
    
    Ok(result)
}

pub fn raw_decrypt_aead(key: &[u8], ciphertext_with_nonce: &[u8]) -> Result<Vec<u8>> {
    if key.len() != 32 {
        return Err(Error::new(Status::InvalidArg, "AES key must be exactly 32 bytes".to_string()));
    }
    if ciphertext_with_nonce.len() < 12 {
        return Err(Error::new(Status::InvalidArg, "Ciphertext too short".to_string()));
    }
    
    let key_slice = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(key_slice);
    
    let (nonce_bytes, ciphertext) = ciphertext_with_nonce.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    
    let payload = aes_gcm::aead::Payload {
        msg: ciphertext,
        aad: &[],
    };
    
    cipher.decrypt(nonce, payload).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Decryption failed: {}", e))
    })
}

use napi_derive::napi;

#[napi(object)]
pub struct Ed25519KeypairObj {
    #[napi(js_name = "publicKey")]
    pub public_key: String,
    #[napi(js_name = "privateKey")]
    pub private_key: String,
}

pub fn generate_ed25519_keypair() -> Result<Ed25519KeypairObj> {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();
    
    Ok(Ed25519KeypairObj {
        public_key: hex::encode(verifying_key.as_bytes()),
        private_key: hex::encode(signing_key.as_bytes()),
    })
}

pub fn sign_ed25519(private_key_hex: String, message: &[u8]) -> Result<String> {
    let key_bytes = hex::decode(&private_key_hex).map_err(|_| {
        Error::new(Status::InvalidArg, "Invalid hex for private key".to_string())
    })?;
    
    if key_bytes.len() != 32 {
        return Err(Error::new(Status::InvalidArg, "Private key must be exactly 32 bytes".to_string()));
    }
    
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&key_bytes);
    
    let signing_key = SigningKey::from_bytes(&arr);
    let signature = signing_key.sign(message);
    
    Ok(hex::encode(signature.to_bytes()))
}
