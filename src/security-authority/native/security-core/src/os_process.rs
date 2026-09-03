use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Error, Result, Status};
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::io::Write;
use crate::crypto;

lazy_static::lazy_static! {
    pub static ref ACTIVE_EXECUTION_HANDLES: Mutex<HashMap<u32, (Child, Vec<u8>)>> = Mutex::new(HashMap::new());
}

pub fn spawn_execution_process(
    pipe_name: String,
    _on_exit: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
) -> Result<u32> {
    let mut handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();

    // Check revocation while holding the lock (Atomic TOCTOU prevention)
    if crate::is_revoked_sync() {
        return Err(Error::new(Status::GenericFailure, "Cannot spawn: system is in REVOKED state".to_string()));
    }

    // 1. Generate session key natively
    let session_key = crypto::random_bytes(32)
        .map_err(|_| Error::new(Status::GenericFailure, "Failed to generate session key".to_string()))?;

    // 2. Hardcode or validate the executable path to prevent Node injection
    let exe_path = "node"; 
    let entry_script = "path/to/runtime/entry.mjs";

    // 3. Spawn process
    let mut child = Command::new(exe_path)
        .arg(entry_script)
        .env("CONTROL_PLANE_PIPE", pipe_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to spawn process: {}", e)))?;

    let pid = child.id();

    // 4. Pass session key via stdin and close it
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(&session_key) {
            let _ = child.kill();
            return Err(Error::new(Status::GenericFailure, format!("Failed to write session key: {}", e)));
        }
    } else {
        let _ = child.kill();
        return Err(Error::new(Status::GenericFailure, "Failed to capture stdin".to_string()));
    }

    // 5. Track the handle to prevent OS PID recycling
    handles.insert(pid, (child, session_key));

    Ok(pid)
}

pub fn terminate_execution_process(pid: u32) -> Result<bool> {
    let mut handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    if let Some((mut child, _)) = handles.remove(&pid) {
        let _ = child.kill();
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn revoke_all_processes() {
    let mut handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    for (_, (child, _)) in handles.iter_mut() {
        let _ = child.kill();
    }
    handles.clear();
}

pub fn get_session_key(pid: u32) -> Option<Vec<u8>> {
    let handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    handles.get(&pid).map(|(_, k)| k.clone())
}

pub fn is_valid_pid(pid: u32) -> bool {
    let handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    handles.contains_key(&pid)
}
