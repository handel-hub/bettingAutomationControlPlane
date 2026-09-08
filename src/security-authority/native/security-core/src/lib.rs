#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};

mod crypto;
mod os_secret;
mod os_pipe;
mod os_process;

static IS_REVOKED: AtomicBool = AtomicBool::new(false);

#[napi]
pub fn is_revoked_sync() -> bool {
    IS_REVOKED.load(Ordering::SeqCst)
}

#[napi]
pub fn set_revoked_sync(revoked: bool) {
    IS_REVOKED.store(revoked, Ordering::SeqCst);
    if revoked {
        os_process::revoke_all_processes();
        let _ = os_pipe::stop_secure_pipe_server();
    }
}

#[napi]
pub fn init() -> Result<()> {
    // Initialization routine: fetch DPAPI key, derive AES key, etc.
    os_secret::initialize_root_key()
}

#[napi]
pub fn verify_machine_identity_sync() -> bool {
    // Attempt to read and unprotect the key to prove machine identity
    os_secret::get_root_key().is_ok()
}

#[napi]
pub fn encrypt_aead(plaintext: Buffer, aad: Buffer) -> Result<Buffer> {
    crypto::encrypt(&plaintext, &aad).map(|v| v.into())
}

#[napi]
pub fn decrypt_aead(ciphertext_with_nonce: Buffer, aad: Buffer) -> Result<Buffer> {
    crypto::decrypt(&ciphertext_with_nonce, &aad).map(|v| v.into())
}

#[napi]
pub fn verify_ed25519(public_key: Buffer, message: Buffer, signature: Buffer) -> Result<bool> {
    crypto::verify_signature(&public_key, &message, &signature)
}

#[napi]
pub fn secure_random(length: u32) -> Result<Buffer> {
    crypto::random_bytes(length as usize).map(|v| v.into())
}

#[napi]
pub fn raw_encrypt_aead(key: Buffer, plaintext: Buffer) -> Result<Buffer> {
    crypto::raw_encrypt_aead(&key, &plaintext).map(|v| v.into())
}

#[napi]
pub fn raw_decrypt_aead(key: Buffer, ciphertext_with_nonce: Buffer) -> Result<Buffer> {
    crypto::raw_decrypt_aead(&key, &ciphertext_with_nonce).map(|v| v.into())
}

#[napi]
pub fn generate_ed25519_keypair() -> Result<crypto::Ed25519KeypairObj> {
    crypto::generate_ed25519_keypair()
}

#[napi]
pub fn sign_ed25519(private_key_hex: String, message: Buffer) -> Result<String> {
    crypto::sign_ed25519(private_key_hex, &message)
}

#[napi(ts_args_type = "pipeName: string, onConnection: (connId: number) => void, onData: (connId: number, data: string) => void, onDisconnect: (connId: number) => void")]
pub fn start_secure_pipe_server(
    pipe_name: String,
    on_connection: napi::threadsafe_function::ThreadsafeFunction<u32, napi::threadsafe_function::ErrorStrategy::Fatal>,
    on_data: napi::threadsafe_function::ThreadsafeFunction<(u32, String), napi::threadsafe_function::ErrorStrategy::Fatal>,
    on_disconnect: napi::threadsafe_function::ThreadsafeFunction<u32, napi::threadsafe_function::ErrorStrategy::Fatal>,
) -> Result<()> {
    os_pipe::start_secure_pipe_server(pipe_name, on_connection, on_data, on_disconnect)
}

#[napi]
pub fn write_pipe(conn_id: u32, data: String) -> Result<bool> {
    os_pipe::write_pipe(conn_id, data)
}

#[napi]
pub fn close_pipe(conn_id: u32) -> Result<()> {
    os_pipe::close_pipe(conn_id)
}

#[napi]
pub fn authorize_hmac(conn_id: u32, hmac: Buffer, session_key: Buffer) -> Result<bool> {
    os_pipe::authorize_hmac(conn_id, hmac, session_key)
}

#[napi]
pub fn authorize_pipe_read(conn_id: u32) -> Result<()> {
    os_pipe::authorize_pipe_read(conn_id)
}

#[napi]
pub fn stop_secure_pipe_server() -> Result<()> {
    os_pipe::stop_secure_pipe_server()
}

#[napi(ts_args_type = "pipeName: string, onExit: (pid: number) => void, scriptPath?: string, expectedSha256?: string")]
pub fn spawn_execution_process(
    pipe_name: String,
    on_exit: napi::threadsafe_function::ThreadsafeFunction<u32, napi::threadsafe_function::ErrorStrategy::Fatal>,
    script_path: Option<String>,
    expected_sha256: Option<String>,
) -> Result<u32> {
    os_process::spawn_execution_process(pipe_name, on_exit, script_path, expected_sha256)
}

#[napi]
pub fn terminate_execution_process(pid: u32) -> Result<bool> {
    os_process::terminate_execution_process(pid)
}

#[napi]
pub fn get_monotonic_counter() -> Result<u32> {
    os_secret::get_monotonic_counter()
}

#[napi]
pub fn increment_monotonic_counter() -> Result<u32> {
    os_secret::increment_monotonic_counter()
}

#[napi]
pub fn set_transition_intent(next_version: u32) -> Result<()> {
    os_secret::set_transition_intent(next_version)
}

#[napi]
pub fn clear_transition_intent() -> Result<()> {
    os_secret::clear_transition_intent()
}

#[napi]
pub fn get_transition_intent() -> Result<i64> {
    os_secret::get_transition_intent()
}

#[napi]
pub fn init_machine_identity() -> Result<()> {
    os_secret::init_machine_identity()
}

#[napi]
pub fn get_machine_public_key() -> Result<String> {
    os_secret::get_machine_public_key()
}

#[napi]
pub fn sign_machine_payload(payload: Buffer) -> Result<String> {
    os_secret::sign_machine_payload(&payload)
}

