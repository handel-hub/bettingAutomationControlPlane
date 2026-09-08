use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Error, Result, Status};
use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::io::Write;
use sha2::{Sha256, Digest};
use std::os::windows::io::AsRawHandle;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, SetInformationJobObject, AssignProcessToJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use crate::crypto;

pub struct ProcessHandle {
    pub child: Child,
    pub session_key: Vec<u8>,
    pub job_handle: isize,
}

lazy_static::lazy_static! {
    pub static ref ACTIVE_EXECUTION_HANDLES: Mutex<HashMap<u32, ProcessHandle>> = Mutex::new(HashMap::new());
}

pub fn spawn_execution_process(
    pipe_name: String,
    _on_exit: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    script_path: Option<String>,
    expected_sha256: Option<String>,
) -> Result<u32> {
    let mut handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();

    // Check revocation while holding the lock (Atomic TOCTOU prevention)
    if crate::is_revoked_sync() {
        return Err(Error::new(Status::GenericFailure, "Cannot spawn: system is in REVOKED state".to_string()));
    }

    // 1. Resolve entry script and verify SHA-256 integrity if required
    let entry_script = script_path.unwrap_or_else(|| "path/to/runtime/entry.mjs".to_string());
    if let Some(expected_hash) = expected_sha256 {
        let script_bytes = std::fs::read(&entry_script)
            .map_err(|e| Error::new(Status::GenericFailure, format!("Failed to read script {}: {}", entry_script, e)))?;
        let computed_hash = hex::encode(Sha256::digest(&script_bytes));
        if computed_hash.to_lowercase() != expected_hash.to_lowercase() {
            return Err(Error::new(
                Status::GenericFailure,
                format!("INTEGRITY_FAILURE: Script hash mismatch for {}. Expected {}, computed {}", entry_script, expected_hash, computed_hash)
            ));
        }
    }

    // 2. Generate session key natively
    let session_key = crypto::random_bytes(32)
        .map_err(|_| Error::new(Status::GenericFailure, "Failed to generate session key".to_string()))?;

    // 3. Create Windows Job Object with KILL_ON_JOB_CLOSE
    let job_handle = unsafe { CreateJobObjectW(None, None) }
        .map_err(|e| Error::new(Status::GenericFailure, format!("CreateJobObject failed: {}", e)))?;
    
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        let res = SetInformationJobObject(
            job_handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if let Err(e) = res {
            let _ = CloseHandle(job_handle);
            return Err(Error::new(Status::GenericFailure, format!("SetInformationJobObject failed: {}", e)));
        }
    }

    // 4. Spawn process
    let exe_path = "node";
    let mut child = Command::new(exe_path)
        .arg(&entry_script)
        .env("CONTROL_PLANE_PIPE", &pipe_name)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            unsafe { let _ = CloseHandle(job_handle); }
            Error::new(Status::GenericFailure, format!("Failed to spawn process: {}", e))
        })?;

    let pid = child.id();

    // 5. Assign child process to Job Object
    let raw_proc_handle = HANDLE(child.as_raw_handle() as isize);
    unsafe {
        if let Err(e) = AssignProcessToJobObject(job_handle, raw_proc_handle) {
            let _ = child.kill();
            let _ = CloseHandle(job_handle);
            return Err(Error::new(Status::GenericFailure, format!("AssignProcessToJobObject failed: {}", e)));
        }
    }

    // 6. Pass session key via stdin and close it
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(&session_key) {
            let _ = child.kill();
            unsafe { let _ = CloseHandle(job_handle); }
            return Err(Error::new(Status::GenericFailure, format!("Failed to write session key: {}", e)));
        }
    } else {
        let _ = child.kill();
        unsafe { let _ = CloseHandle(job_handle); }
        return Err(Error::new(Status::GenericFailure, "Failed to capture stdin".to_string()));
    }

    // 7. Track the handle to prevent OS PID recycling
    handles.insert(pid, ProcessHandle {
        child,
        session_key,
        job_handle: job_handle.0 as isize,
    });

    Ok(pid)
}

pub fn terminate_execution_process(pid: u32) -> Result<bool> {
    let mut handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    if let Some(mut proc_handle) = handles.remove(&pid) {
        let _ = proc_handle.child.kill();
        if proc_handle.job_handle != 0 {
            unsafe {
                let _ = CloseHandle(HANDLE(proc_handle.job_handle));
            }
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

pub fn revoke_all_processes() {
    let mut handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    for (_, proc_handle) in handles.iter_mut() {
        let _ = proc_handle.child.kill();
        if proc_handle.job_handle != 0 {
            unsafe {
                let _ = CloseHandle(HANDLE(proc_handle.job_handle));
            }
        }
    }
    handles.clear();
}

pub fn get_session_key(pid: u32) -> Option<Vec<u8>> {
    let handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    handles.get(&pid).map(|p| p.session_key.clone())
}

pub fn is_valid_pid(pid: u32) -> bool {
    let handles = ACTIVE_EXECUTION_HANDLES.lock().unwrap();
    handles.contains_key(&pid)
}
