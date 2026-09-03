use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi::{Error, Result, Status};
use std::collections::HashMap;
use std::ffi::CString;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicBool, Ordering};
use windows::core::PCSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorA, SDDL_REVISION_1,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeA, DisconnectNamedPipe, GetNamedPipeClientProcessId, PeekNamedPipe,
    PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_WAIT,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::os_process;

lazy_static::lazy_static! {
    static ref CONNECTIONS: Mutex<HashMap<u32, HANDLE>> = Mutex::new(HashMap::new());
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

            let handle = unsafe {
                match CreateNamedPipeA(
                    PCSTR::from_raw(pipe_name_c.as_ptr() as *const u8),
                    windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(3 | 0x00080000), 
                    PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                    255, 
                    65536,
                    65536,
                    0,
                    Some(&sa),
                ) {
                    Ok(h) => h,
                    Err(_) => {
                        let _ = windows::Win32::Foundation::LocalFree(
                            windows::Win32::Foundation::HLOCAL(sd_ptr),
                        );
                        break;
                    }
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
                        e.code() == windows::core::HRESULT::from_win32(windows::Win32::Foundation::ERROR_PIPE_CONNECTED.0)
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
                // Verify PID
                let mut client_pid: u32 = 0;
                let pid_success = unsafe { GetNamedPipeClientProcessId(handle, &mut client_pid) };
                
                if pid_success.is_err() || !os_process::is_valid_pid(client_pid) {
                    unsafe {
                        let _ = DisconnectNamedPipe(handle);
                        let _ = CloseHandle(handle);
                    }
                    continue; // Drop connection immediately
                }

                let session_key_opt = os_process::get_session_key(client_pid);
                if session_key_opt.is_none() {
                    unsafe {
                        let _ = DisconnectNamedPipe(handle);
                        let _ = CloseHandle(handle);
                    }
                    continue;
                }
                let session_key = session_key_opt.unwrap();

                let mut id_lock = NEXT_CONN_ID.lock().unwrap();
                let conn_id = *id_lock;
                *id_lock += 1;
                drop(id_lock);

                let on_conn_clone = on_connection.clone();
                let on_data_clone = on_data.clone();
                let on_disc_clone = on_disconnect.clone();

                // Spawn thread for this connection to handle HMAC and reading
                thread::spawn(move || {
                    let start = Instant::now();
                    let mut authenticated = false;
                    
                    // 1. Wait for HMAC with 2000ms timeout
                    loop {
                        if start.elapsed() > Duration::from_millis(2000) {
                            break;
                        }
                        
                        let mut bytes_avail = 0;
                        unsafe {
                            let _ = PeekNamedPipe(
                                handle,
                                None,
                                0,
                                None,
                                Some(&mut bytes_avail),
                                None
                            );
                        }

                        if bytes_avail >= 32 {
                            let mut hmac_buf = [0u8; 32];
                            let mut bytes_read = 0;
                            let success = unsafe {
                                ReadFile(handle, Some(&mut hmac_buf), Some(&mut bytes_read), None)
                            };
                            if success.is_ok() && bytes_read == 32 {
                                let mut mac = Hmac::<Sha256>::new_from_slice(&session_key).unwrap();
                                let mut msg = b"IPC_AUTH".to_vec();
                                msg.extend_from_slice(conn_id.to_string().as_bytes());
                                mac.update(&msg);
                                
                                if mac.verify_slice(&hmac_buf).is_ok() {
                                    authenticated = true;
                                }
                            }
                            break;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }

                    if !authenticated {
                        unsafe {
                            let _ = DisconnectNamedPipe(handle);
                            let _ = CloseHandle(handle);
                        }
                        return;
                    }

                    // Authenticated: insert into CONNECTIONS
                    CONNECTIONS.lock().unwrap().insert(conn_id, handle);
                    
                    on_conn_clone.call(
                        conn_id,
                        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                    );

                    // Proceed to framing loop
                    loop {
                        let mut len_buf = [0u8; 4];
                        let mut bytes_read = 0;
                        let success = unsafe {
                            ReadFile(handle, Some(&mut len_buf), Some(&mut bytes_read), None)
                        };

                        if success.is_err() || bytes_read == 0 {
                            break; // Disconnected
                        }

                        if bytes_read == 4 {
                            let msg_len = u32::from_be_bytes(len_buf) as usize;
                            if msg_len > 10 * 1024 * 1024 {
                                break; // Max message size exceeded
                            }
                            
                            let mut msg_buf = vec![0u8; msg_len];
                            let mut total_read = 0;
                            while total_read < msg_len {
                                let mut chunk_read = 0;
                                let chunk_success = unsafe {
                                    ReadFile(
                                        handle,
                                        Some(&mut msg_buf[total_read..]),
                                        Some(&mut chunk_read),
                                        None
                                    )
                                };
                                if chunk_success.is_err() || chunk_read == 0 {
                                    break;
                                }
                                total_read += chunk_read as usize;
                            }
                            
                            if total_read == msg_len {
                                if let Ok(msg_str) = std::str::from_utf8(&msg_buf) {
                                    on_data_clone.call(
                                        (conn_id, msg_str.to_string()),
                                        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                                    );
                                }
                            } else {
                                break;
                            }
                        }
                    }

                    // Cleanup on disconnect
                    CONNECTIONS.lock().unwrap().remove(&conn_id);
                    unsafe {
                        let _ = DisconnectNamedPipe(handle);
                        let _ = CloseHandle(handle);
                    }
                    on_disc_clone.call(
                        conn_id,
                        napi::threadsafe_function::ThreadsafeFunctionCallMode::NonBlocking,
                    );
                });
            } else {
                unsafe {
                    let _ = CloseHandle(handle);
                }
            }
        }
    });

    Ok(())
}

pub fn authorize_pipe_read(_conn_id: u32) -> Result<()> {
    // Legacy: No longer needed as thread is spawned immediately upon authentication
    Ok(())
}

pub fn stop_secure_pipe_server() -> Result<()> {
    SERVER_RUNNING.store(false, Ordering::SeqCst);
    let pipe_name = SERVER_PIPE_NAME.lock().unwrap().clone();
    if !pipe_name.is_empty() {
        let _ = std::fs::OpenOptions::new().read(true).write(true).open(&pipe_name);
    }
    let mut conns = CONNECTIONS.lock().unwrap();
    for (_, handle) in conns.drain() {
        unsafe {
            let _ = DisconnectNamedPipe(handle);
            let _ = CloseHandle(handle);
        }
    }
    Ok(())
}

pub fn write_pipe(conn_id: u32, data: String) -> Result<bool> {
    let handle = {
        let conns = CONNECTIONS.lock().unwrap();
        if let Some(&h) = conns.get(&conn_id) {
            h
        } else {
            return Ok(false);
        }
    };

    let bytes = data.as_bytes();
    let len_prefix = (bytes.len() as u32).to_be_bytes();
    
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&len_prefix);
    frame.extend_from_slice(bytes);

    let mut bytes_written = 0;
    let success = unsafe { WriteFile(handle, Some(&frame), Some(&mut bytes_written), None) };

    Ok(success.is_ok())
}

pub fn close_pipe(conn_id: u32) -> Result<()> {
    let handle_opt = {
        let mut conns = CONNECTIONS.lock().unwrap();
        conns.remove(&conn_id)
    };
    
    if let Some(h) = handle_opt {
        unsafe {
            let _ = DisconnectNamedPipe(h);
            let _ = CloseHandle(h);
        }
    }
    Ok(())
}

pub fn authorize_hmac(_conn_id: u32, _hmac: napi::bindgen_prelude::Buffer, _session_key: napi::bindgen_prelude::Buffer) -> Result<bool> {
    // Legacy: No longer exposed to Node
    Ok(false)
}