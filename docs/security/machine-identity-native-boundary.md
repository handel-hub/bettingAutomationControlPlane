# Machine Identity Native Boundary

## Threat Model
The Control Plane Security Authority operates under a highly hostile threat model where the attacker is assumed to have full local access to the system, including the ability to execute code as the service user and perform memory dumps of the Node.js V8 process heap. 

## Old Architecture & Vulnerability
In the legacy implementation, the Machine Identity Ed25519 keypair was generated natively but the raw `privateKeyHex` was returned across the NAPI boundary and stored in JavaScript memory (`machine-identity.mjs`). Because JavaScript Strings and Buffers are immutable and garbage-collected asynchronously, this explicitly leaked the root Machine Identity private key into the V8 heap, making it vulnerable to trivial memory extraction by a local attacker.

## New Architecture
The Machine Identity lifecycle is now completely encapsulated within the Rust Native Core. JavaScript operates as a blind client, acting as a pass-through for cryptographic operations without ever possessing the secret key material.

### NAPI Boundary
JavaScript interacts with the identity through three opaque, tightly constrained NAPI methods:
1. `init_machine_identity()`: Triggers native initialization.
2. `get_machine_public_key()`: Retrieves only the public key.
3. `sign_machine_payload(payload)`: Submits a payload for native signing and receives only the hex signature.

### DPAPI & Key Lifecycle
- **Initialization**: When `init_machine_identity()` is called, Rust natively generates an `ed25519-dalek` keypair using `OsRng`. The secret scalar is immediately encrypted using Windows DPAPI (`CryptProtectData`) tied to the user/machine context. 
- **Storage**: The ciphertext is persisted to `%APPDATA%/.security_authority/machine_identity.bin`. The plaintext secret key is never written to disk.
- **Signing Flow**: During `sign_machine_payload()`, Rust loads the ciphertext from disk, calls DPAPI `CryptUnprotectData` to decrypt it into a local stack buffer, reconstructs the `SigningKey`, signs the payload, and then manually zeroizes the temporary plaintext buffer before dropping it. Only the resulting signature crosses the NAPI boundary back into V8.
- **Failure Behavior**: If the DPAPI blob exists but is corrupted, tampered with, or fails MAC validation, the system **fails closed**. It throws a native error across NAPI (`DPAPI CryptUnprotectData failed`) and explicitly does **not** silently regenerate a new identity. This prevents attackers from easily downgrading or resetting the machine identity.

## Limitations
- **DPAPI Boundaries**: While the private key never crosses into the JavaScript V8 heap (preventing JS memory dump extraction), the key is decrypted into the Rust process memory space during the microsecond of the signing operation. An attacker with advanced kernel-level access or a highly timed native debugger could theoretically extract it during this window.
- **Local Execution**: DPAPI protects against offline extraction and cross-user extraction. However, if the attacker can execute arbitrary native code under the exact same Windows User Profile, they can manually invoke `CryptUnprotectData` on the `machine_identity.bin` file. True hardware isolation would require a TPM/Secure Enclave backend instead of DPAPI.

## Test Evidence
All security invariants are continuously verified by the `machine-identity-encapsulation.test.mjs` adversarial test suite:
- **Test 4 (JavaScript Private-Key Absence)** explicitly verifies that `machineIdentity` holds no references to `privateKey`, `privateKeyHex`, or any equivalent property.
- **Test 6 & 7 (Restart Persistence)** verify that the identity remains completely stable across process restarts.
- **Test 8/9/10 (DPAPI Corruption)** verify that modifying a single byte of the persistent DPAPI blob causes a hard fault, proving the system fails closed under tampering.
