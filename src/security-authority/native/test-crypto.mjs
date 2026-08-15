import { CryptoProviderNativeWrapper } from '../crypto/bindings.mjs';

function runCryptoTests() {
  console.log("=== Testing Native Crypto Provider ===");

  try {
    console.log("[1] Generating Random Bytes...");
    const rand = CryptoProviderNativeWrapper.generateRandomBytes(32);
    console.log(`    Generated ${rand.length} bytes:`, rand.toString('hex'));
    if (rand.length !== 32) throw new Error("Invalid random bytes length");

    console.log("[2] Generating Ed25519 Keypair...");
    const keypair = CryptoProviderNativeWrapper.generateEd25519Keypair();
    console.log(`    Private Key: ${keypair.privateKey.slice(0, 8)}...`);
    console.log(`    Public Key:  ${keypair.publicKey}`);

    console.log("[3] Signing Message...");
    const msg = Buffer.from("Control Plane Integrity Check");
    const sig = CryptoProviderNativeWrapper.signEd25519(keypair.privateKey, msg);
    console.log(`    Signature:   ${sig}`);

    console.log("[4] Verifying Signature...");
    const valid = CryptoProviderNativeWrapper.verifyEd25519(keypair.publicKey, msg, sig);
    console.log(`    Verified?    ${valid}`);
    if (!valid) throw new Error("Signature verification failed");

    console.log("[5] Verifying Signature with bad data...");
    const msgBad = Buffer.from("Control Plane Integrity Check FAKED");
    const validBad = CryptoProviderNativeWrapper.verifyEd25519(keypair.publicKey, msgBad, sig);
    console.log(`    Verified bad data? ${validBad}`);
    if (validBad) throw new Error("Signature verification succeeded on bad data");

    console.log("[6] AEAD Encrypt...");
    const aesKey = CryptoProviderNativeWrapper.generateRandomBytes(32);
    const plaintext = Buffer.from("Super Secret Server Trust Material");
    const ciphertext = CryptoProviderNativeWrapper.encryptAead(aesKey, plaintext);
    console.log(`    Ciphertext length: ${ciphertext.length} bytes`);

    console.log("[7] AEAD Decrypt...");
    const decrypted = CryptoProviderNativeWrapper.decryptAead(aesKey, ciphertext);
    console.log(`    Decrypted:   ${decrypted.toString('utf8')}`);
    if (decrypted.toString('utf8') !== plaintext.toString('utf8')) throw new Error("AEAD decryption mismatch");

    console.log("✅ All Crypto Native Integration Tests Passed!");
  } catch (err) {
    console.error("❌ Crypto Test Failed:", err.message);
    process.exit(1);
  }
}

runCryptoTests();
