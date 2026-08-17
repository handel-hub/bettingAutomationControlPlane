use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Error, Result, Status};
use std::collections::HashMap;
use std::ffi::CString;
use std::sync::Mutex;
use std::thread;
use std::sync::atomic::{AtomicBool, Ordering};
use windows::core::PCSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorA, SDDL_REVISION_1,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeA, DisconnectNamedPipe,
    PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};

pub struct Connection {
    pub handle: HANDLE,
    pub on_data: ThreadsafeFunction<(u32, String), ErrorStrategy::Fatal>,
    pub on_disconnect: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
}

lazy_static::lazy_static! {
    static ref CONNECTIONS: Mutex<HashMap<u32, Connection>> = Mutex::new(HashMap::new());
    static ref NEXT_CONN_ID: Mutex<u32> = Mutex::new(1);
    pub static ref SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
    static ref SERVER_PIPE_NAME: Mutex<String> = Mutex::new(String::new());
}

pub fn start_secure_pipe_server(
    pipe_name: String,
    on_connection: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
    on_data: ThreadsafeFunction<(u32, String), ErrorStrategy::Fatal>,
    on_disconnect: ThreadsafeFunction<u32, ErrorStrategy::Fatal>,
) -> Result<()> {
    let sddl = CString::new("D:(A;;GA;;;SY)(A;;GA;;;OW)").unwrap();

    let mut sd_ptr = std::ptr::null_mut();
    unsafe {
        let success = ConvertStringSecurityDescriptorToSecurityDescriptorA(
            PCSTR::from_raw(sddl.as_ptr() as *const u8),
            SDDL_REVISION_1,
            &mut sd_ptr as *mut *mut std::ffi::c_void
                as *mut windows::Win32::Security::PSECURITY_DESCRIPTOR,
            None,
        );
        if success.is_err() {
            return Err(Error::new(
                Status::GenericFailure,
                "ConvertStringSecurityDescriptorToSecurityDescriptorA failed".to_string(),
            ));
        }
    }

    let sd_ptr_val = sd_ptr as usize;
    let pipe_name_c = CString::new(pipe_name.clone()).unwrap();

    SERVER_RUNNING.store(true, Ordering::SeqCst);
    *SERVER_PIPE_NAME.lock().unwrap() = pipe_name.clone();

    thread::spawn(move || {
        let sd_ptr = sd_ptr_val as *mut std::ffi::c_void;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd_ptr,
            bInheritHandle: windows::Win32::Foundation::BOOL(0),
        };
        loop {
            if !SERVER_RUNNING.load(Ordering::SeqCst) {
                unsafe {
                    let _ = windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(sd_ptr),
                    );
                }
                break;
            }

            let handle_res = unsafe {
                CreateNamedPipeA(
                    PCSTR::from_raw(pipe_name_c.as_ptr() as *const u8),
                    windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(3 | 0x00080000), // PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE
                    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                    255, // Max instances
                    65536,
                    65536,
                    0,
                    Some(&sa),
                )
            };

            let handle = match handle_res {
                Ok(h) => h,
                Err(_) => {
                    unsafe {
                        let _ = windows::Win32::Foundation::LocalFree(
                            windows::Win32::Foundation::HLOCAL(sd_ptr),
                        );
                    }
                    break;
                }
            };

            if handle == INVALID_HANDLE_VALUE {
                unsafe {
                    let _ = windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(sd_ptr),
                    );
                }
                break;
            }

            let connected = unsafe {
                match ConnectNamedPipe(handle, None) {
                    Ok(_) => true,
                    Err(e) => {
                        e.code()
                            == windows::core::HRESULT::from_win32(
                                windows::Win32::Foundation::ERROR_PIPE_CONNECTED.0,
                            )
                    }
                }
            };

            if !SERVER_RUNNING.load(Ordering::SeqCst) {
                unsafe {
                    let _ = DisconnectNamedPipe(handle);
                    let _ = CloseHandle(handle);
                    let _ = windows::Win32::Foundation::LocalFree(
                        windows::Win32::Foundation::HLOCAL(sd_ptr),
                    );
                }
                break;
            }

            if connected {
                let mut id_lock = NEXT_CONN_ID.lock().unwrap();
                let conn_id = *id_lock;
                *id_lock += 1;
                drop(id_lock);

                CONNECTIONS.lock().unwrap().insert(conn_id, Connection {
                    handle,
                    on_data: on_data.clone(),
                    on_disconnect: on_disconnect.clone(),
                });
                
                on_connection.call(
                    conn_id,
                    napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                );

                // DATA READING THREAD IS NO LONGER SPAWNED HERE
                // The Node.js layer must call authorize_pipe_read to explicitly start consuming data.
            } else {
                unsafe {
                    let _ = CloseHandle(handle);
                }
            }
        }
    });

    Ok(())
}

pub fn authorize_pipe_read(conn_id: u32) -> Result<()> {
    let (handle, on_data, on_disconnect) = {
        let conns = CONNECTIONS.lock().unwrap();
        if let Some(c) = conns.get(&conn_id) {
            (c.handle, c.on_data.clone(), c.on_disconnect.clone())
        } else {
            return Err(Error::new(Status::InvalidArg, "Unknown connection ID".to_string()));
        }
    };

    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            let mut bytes_read = 0;
            let success = unsafe {
                ReadFile(handle, Some(&mut buffer), Some(&mut bytes_read), None)
            };

            if success.is_err() || bytes_read == 0 {
                CONNECTIONS.lock().unwrap().remove(&conn_id);
                unsafe {
                    let _ = DisconnectNamedPipe(handle);
                    let _ = CloseHandle(handle);
                }
                on_disconnect.call(
                    conn_id,
                    napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                );
                break;
            }

            if let Ok(msg) = std::str::from_utf8(&buffer[..bytes_read as usize]) {
                on_data.call(
                    (conn_id, msg.to_string()),
                    napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        }
    });

    Ok(())
}

pub fn stop_secure_pipe_server() -> Result<()> {
    SERVER_RUNNING.store(false, Ordering::SeqCst);
    let pipe_name = SERVER_PIPE_NAME.lock().unwrap().clone();
    if !pipe_name.is_empty() {
        let _ = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_name);
    }
    // Also disconnect all existing connections to abort their threads
    let mut conns = CONNECTIONS.lock().unwrap();
    for (_, c) in conns.drain() {
        unsafe {
            let _ = DisconnectNamedPipe(c.handle);
            let _ = CloseHandle(c.handle);
        }
        // Callbacks will be dropped
    }
    Ok(())
}

pub fn write_pipe(conn_id: u32, data: String) -> Result<bool> {
    let handle = {
        let conns = CONNECTIONS.lock().unwrap();
        if let Some(c) = conns.get(&conn_id) {
            c.handle
        } else {
            return Ok(false);
        }
    };

    let mut bytes_written = 0;
    let success = unsafe { WriteFile(handle, Some(data.as_bytes()), Some(&mut bytes_written), None) };

    Ok(success.is_ok())
}

pub fn close_pipe(conn_id: u32) -> Result<()> {
    let handle_opt = {
        let mut conns = CONNECTIONS.lock().unwrap();
        conns.remove(&conn_id).map(|c| c.handle)
    };
    
    if let Some(h) = handle_opt {
        unsafe {
            let _ = DisconnectNamedPipe(h);
            let _ = CloseHandle(h);
        }
    }
    Ok(())
}

use hmac::{Hmac, Mac};
use sha2::Sha256;
use napi::bindgen_prelude::Buffer;

pub fn authorize_hmac(conn_id: u32, hmac: Buffer, session_key: Buffer) -> Result<bool> {
    let _handle = {
        let conns = CONNECTIONS.lock().unwrap();
        if let Some(c) = conns.get(&conn_id) {
            c.handle
        } else {
            return Err(Error::new(
                Status::InvalidArg,
                "Unknown connection ID".to_string(),
            ));
        }
    };

    let mut mac = Hmac::<Sha256>::new_from_slice(&session_key).map_err(|_| {
        Error::new(Status::GenericFailure, "HMAC init failed".to_string())
    })?;

    let mut msg = b"IPC_AUTH".to_vec();
    msg.extend_from_slice(conn_id.to_string().as_bytes());
    
    mac.update(&msg);
    if mac.verify_slice(&hmac).is_ok() {
        Ok(true)
    } else {
        let _ = close_pipe(conn_id);
        Ok(false)
    }
}