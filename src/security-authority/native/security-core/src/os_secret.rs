use napi::{Error, Result, Status};
use std::fs;
use std::path::PathBuf;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};
use std::ptr::null_mut;
use rand::RngCore;

fn get_key_path() -> Result<PathBuf> {
    let mut path = dirs::config_dir().ok_or_else(|| {
        Error::new(Status::GenericFailure, "Could not find config dir".to_string())
    })?;
    path.push(".security_authority");
    fs::create_dir_all(&path).ok();
    path.push("root_key.bin");
    Ok(path)
}

pub fn initialize_root_key() -> Result<()> {
    let path = get_key_path()?;
    if !path.exists() {
        // Generate a 32-byte key
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        
        let encrypted_key = protect_data(&key)?;
        fs::write(&path, encrypted_key).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Failed to write root key: {}", e))
        })?;
    } else {
        // Verify it can be unprotected (proves machine identity matches)
        let _ = get_root_key()?;
    }
    Ok(())
}

pub fn get_root_key() -> Result<Vec<u8>> {
    let path = get_key_path()?;
    let encrypted_key = fs::read(&path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to read root key: {}", e))
    })?;
    unprotect_data(&encrypted_key)
}

fn protect_data(data: &[u8]) -> Result<Vec<u8>> {
    unsafe {
        let mut data_in = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut data_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };

        let result = CryptProtectData(
            &mut data_in,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut data_out,
        );

        if result.is_ok() {
            let out_slice = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize);
            let vec = out_slice.to_vec();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(data_out.pbData as *mut _));
            Ok(vec)
        } else {
            Err(Error::new(Status::GenericFailure, "DPAPI CryptProtectData failed".to_string()))
        }
    }
}

fn unprotect_data(data: &[u8]) -> Result<Vec<u8>> {
    unsafe {
        let mut data_in = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut data_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };

        let result = CryptUnprotectData(
            &mut data_in,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut data_out,
        );

        if result.is_ok() {
            let out_slice = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize);
            let vec = out_slice.to_vec();
            let _ = windows::Win32::Foundation::LocalFree(windows::Win32::Foundation::HLOCAL(data_out.pbData as *mut _));
            Ok(vec)
        } else {
            Err(Error::new(Status::GenericFailure, "DPAPI CryptUnprotectData failed".to_string()))
        }
    }
}

fn get_counter_path() -> Result<PathBuf> {
    let mut path = dirs::config_dir().ok_or_else(|| {
        Error::new(Status::GenericFailure, "Could not find config dir".to_string())
    })?;
    path.push(".security_authority");
    fs::create_dir_all(&path).ok();
    path.push("version_counter.bin");
    Ok(path)
}

pub fn get_monotonic_counter() -> Result<u32> {
    let path = get_counter_path()?;
    if !path.exists() {
        return Ok(0);
    }
    let encrypted_data = fs::read(&path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to read counter: {}", e))
    })?;
    let decrypted = unprotect_data(&encrypted_data)?;
    if decrypted.len() != 4 {
        return Ok(0);
    }
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&decrypted[..4]);
    Ok(u32::from_le_bytes(bytes))
}

pub fn increment_monotonic_counter() -> Result<u32> {
    let current = get_monotonic_counter()?;
    let next = current + 1;
    let path = get_counter_path()?;
    let encrypted_data = protect_data(&next.to_le_bytes())?;
    fs::write(&path, encrypted_data).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to write counter: {}", e))
    })?;
    Ok(next)
}

fn get_intent_path() -> Result<PathBuf> {
    let mut path = dirs::config_dir().ok_or_else(|| {
        Error::new(Status::GenericFailure, "Could not find config dir".to_string())
    })?;
    path.push(".security_authority");
    fs::create_dir_all(&path).ok();
    path.push("intent.bin");
    Ok(path)
}

pub fn set_transition_intent(next_version: u32) -> Result<()> {
    let path = get_intent_path()?;
    let encrypted_data = protect_data(&next_version.to_le_bytes())?;
    fs::write(&path, encrypted_data).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to write intent: {}", e))
    })?;
    Ok(())
}

pub fn clear_transition_intent() -> Result<()> {
    let path = get_intent_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Failed to clear intent: {}", e))
        })?;
    }
    Ok(())
}

pub fn get_transition_intent() -> Result<i64> {
    let path = get_intent_path()?;
    if !path.exists() {
        return Ok(-1);
    }
    let encrypted_data = fs::read(&path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to read intent: {}", e))
    })?;
    let decrypted = unprotect_data(&encrypted_data)?;
    if decrypted.len() != 4 {
        return Err(Error::new(Status::GenericFailure, "Corrupted intent length".to_string()));
    }
    let mut bytes = [0u8; 4];
    bytes.copy_from_slice(&decrypted[..4]);
    Ok(u32::from_le_bytes(bytes) as i64)
}

fn get_machine_id_path() -> Result<PathBuf> {
    let mut path = dirs::config_dir().ok_or_else(|| {
        Error::new(Status::GenericFailure, "Could not find config dir".to_string())
    })?;
    path.push(".security_authority");
    fs::create_dir_all(&path).ok();
    path.push("machine_identity.bin");
    Ok(path)
}

pub fn init_machine_identity() -> Result<()> {
    let path = get_machine_id_path()?;
    if !path.exists() {
        use ed25519_dalek::SigningKey;
        use rand::rngs::OsRng;
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng);
        
        let encrypted_key = protect_data(signing_key.as_bytes())?;
        fs::write(&path, encrypted_key).map_err(|e| {
            Error::new(Status::GenericFailure, format!("Failed to write machine identity: {}", e))
        })?;
    } else {
        // Validate it can be decrypted. Do NOT generate a new one if this fails (fail closed).
        let _ = get_machine_private_key()?;
    }
    Ok(())
}

fn get_machine_private_key() -> Result<ed25519_dalek::SigningKey> {
    let path = get_machine_id_path()?;
    if !path.exists() {
        return Err(Error::new(Status::GenericFailure, "Machine identity not initialized".to_string()));
    }
    let encrypted_data = fs::read(&path).map_err(|e| {
        Error::new(Status::GenericFailure, format!("Failed to read machine identity: {}", e))
    })?;
    let mut decrypted = unprotect_data(&encrypted_data)?;
    if decrypted.len() != 32 {
        return Err(Error::new(Status::GenericFailure, "Corrupted machine identity length".to_string()));
    }
    
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&decrypted[..32]);
    
    // Explicit manual zeroization of the DPAPI plaintext heap buffer.
    // The SigningKey struct will maintain its own copy securely.
    for byte in decrypted.iter_mut() {
        *byte = 0;
    }
    
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&arr);
    
    // Zeroize the array copy as well
    for byte in arr.iter_mut() {
        *byte = 0;
    }
    
    Ok(signing_key)
}

pub fn get_machine_public_key() -> Result<String> {
    let signing_key = get_machine_private_key()?;
    let verifying_key = signing_key.verifying_key();
    Ok(hex::encode(verifying_key.as_bytes()))
}

pub fn sign_machine_payload(payload: &[u8]) -> Result<String> {
    use ed25519_dalek::Signer;
    let signing_key = get_machine_private_key()?;
    
    // Domain separation
    let mut prefixed_payload = Vec::with_capacity(16 + payload.len());
    prefixed_payload.extend_from_slice(b"CONTROL_PLANE_V1");
    prefixed_payload.extend_from_slice(payload);
    
    let signature = signing_key.sign(&prefixed_payload);
    Ok(hex::encode(signature.to_bytes()))
}

