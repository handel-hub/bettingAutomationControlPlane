# Section 13.4 — Build Provenance, Secrets Scan, Client Binary / Bundle, Local Artifacts & Update Channel Forensics

## 1. Build Provenance & Native Addon Analysis (`audit/surface.json`)

Full machine-readable discovery data is persisted in [`audit/surface.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/surface.json):

- **Control Plane Native Security Core (`src/security-authority/native/security-core`)**:
  - Binary artifact: `security-core.win32-x64-msvc.node` (`215,040` bytes, SHA-256: `b3cf66c9c4308c81b92b9f3f3c425f71b3bbbf5fa26cfbe1881566a3c582e2dc`).
  - Compiled from Rust NAPI-RS (`Cargo.toml` / `src/lib.rs`, `src/crypto.rs`, `src/os_secret.rs`, `src/fingerprint.rs`, `src/envelope.rs`).
  - **Exported Security Primitives**:
    - `encryptAead` / `decryptAead`: AES-256-GCM authenticated encryption binding `machine_id`, `state_version`, and `security_state` in AAD.
    - `sealMasterSecret` / `unsealMasterSecret`: Windows DPAPI (`CryptProtectData` / `CryptUnprotectData`) + Registry (`HKCU\Software\BettingAutomation\ControlPlane`) persistence for the local 32-byte master key.
    - `incrementTransitionIntent` / `getTransitionIntent`: OS-level monotonic transition counter stored in Windows Registry to detect offline SQLite database snapshot replacement (`PF-17`, `TIME-ROLLBACK-01`).
    - `getHardwareFingerprint`: Hardware fingerprint binding CPU, motherboard/BIOS, and OS machine GUID (`INV-08`).
- **JavaScript / Bytecode Packaging (`scripts/compile-bytecode.mjs`, `scripts/build-package.mjs`)**:
  - Control Plane and Execution Plane compile ES modules via `esbuild` + `bytenode` (`.jsc` V8 bytecode) for release distribution.
  - **Threat Model Assessment (`CLIENT-PROT-01`, `CP-TAMPER-01`, `CP-TAMPER-02`)**: Under our zero-trust local threat model (T4 Local Admin / Reverse Engineer), V8 bytecode and local DPAPI keys are treated strictly as defense-in-depth anti-tamper layers, **not** as substitutes for server-side authority. All financial, subscription, licensing, and account-limit invariants (`INV-01`–`INV-06`) are enforced authoritatively on the Backend (`bettingAutomationBackend`).

---

## 2. Secrets & Credential Hygiene Scan (`audit/surface.json` & `CLIENT-PROT-01`)

- **Source & Git History Scan**:
  - Scanned `src/` across all 4 repositories (`bettingAutomationBackend`, `bettingAutomationControlPlane`, `bettingAutomation`, `betting-automation-frontend`): `liveSecretMatchesCount: 0`.
  - Zero live Paystack (`sk_live_*`), Flutterwave (`FLWSECK_LIVE*`), or production private keys are committed in source or configuration templates.
- **Backend KMS Signing Key Isolation**:
  - Backend Ed25519 private signing keys reside exclusively in `bettingAutomationBackend/src/crypto/kms-adapter.mjs` (`LocalKmsAdapter` / production KMS).
  - Control Plane (`src/security-authority/constants.mjs`) and Execution Plane (`bettingAutomation`) embed **only** the Backend Ed25519 public verification keys (`KEY_DIRECTORY`).
- **Local Artifact & Credential Storage (`CLIENT-PROT-01`)**:
  - Evidence: [`audit/evidence/CLIENT-PROT-01/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/CLIENT-PROT-01/result.json) (`EXECUTED-PASS`).
  - **Control Plane SQLite State (`security_state`)**: Encrypted via `AEADStorageAdapter` (AES-256-GCM). Inspecting raw SQLite bytes confirmed `plaintextCanaryFoundInRawDb: false`.
  - **Execution Plane Bookmaker Session Storage (`bettingAutomation/src/auth/SessionManager.js`)**: Cookies and DOMStorage extracted via CDP are encrypted with AES-256-GCM (`scryptSync` key derivation + random 16-byte IV + 16-byte auth tag) in `.enc` files (`plaintextCanaryFoundInSessionEnc: false`).
  - **IPC Shared Secrets**: Ephemeral per-boot 256-bit random tokens passed via environment/file with restricted local permissions (`ACP_IPC_SECRET`, `.acp-ipc-token`).

---

## 3. Update & System Control Channel Forensics (`UPDATE-01` & `PF-16`)

- Evidence: [`audit/evidence/UPDATE-01/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/UPDATE-01/result.json), [`audit/evidence/PF-16/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-16/result.json), [`audit/evidence/PF-13/result.json`](file:///c:/Users/John/Documents/CODE/back/bettingAutomationControlPlane/audit/evidence/PF-13/result.json).
- **Backend Update Trigger (`POST /api/v1/system/restart-and-update`)**:
  - Enforces dual-gate authorization in `bettingAutomationBackend/src/api/routes/system.mjs:24-68`: requires either a verified `SUPER_ADMIN` session (`verifyAdminSession(authHeader, 'SUPER_ADMIN')`) or an authenticated operator holding an active `VALID` license with `CAP_UPDATE_INSTALL` / `CAP_SYSTEM_UPDATE`. Standard operators (`Pro` / `Starter`) are rejected with HTTP `403 BE_PERM_ENTITLEMENT_EXCEEDED`.
- **Execution Plane Binary/Script Verification (`ExecutionIntegrityVerifier`)**:
  - Before spawning the Execution Plane process, `RuntimeManager` (`src/runtime-manager/runtime-manager.mjs`) invokes `ExecutionIntegrityVerifier.verify(entryScriptPath, expectedHash)`. Any modification to the Execution Plane entry script triggers `EXECUTION_INTEGRITY_VIOLATION` (`PF-13`) and halts spawn.
