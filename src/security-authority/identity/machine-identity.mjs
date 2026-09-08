// @ts-check

import { NativeCore } from '../native/security-core.mjs';

/**
 * Manages the cryptographic identity of the hardware.
 * Strictly uses NativeCore DPAPI encapsulation to ensure the
 * private key never enters the V8/Node.js memory heap.
 */
export class MachineIdentity {
  constructor() {
    /** @type {string | null} */
    this.hardwareId = null;
    /** @type {string | null} */
    this.publicKeyHex = null;
  }

  /**
   * Initializes or loads the machine identity natively from DPAPI.
   */
  async initialize() {
    // Triggers DPAPI initialization natively
    NativeCore.initMachineIdentity();
    
    // Retrieve only the public key
    this.publicKeyHex = NativeCore.getMachinePublicKey();
    
    // Derive deterministic hardware identifier securely from Rust.
    // Instead of importing Node crypto or relying on random bytes (which break clone detection),
    // we use the NativeCore to sign a static seed. The DPAPI private key remains entirely
    // within the Rust boundary, and the resulting signature is deterministic across reboots.
    const signatureHex = NativeCore.signMachinePayload(Buffer.from("MACHINE_IDENTITY_SEED", "utf8"));
    this.hardwareId = `hw_${signatureHex.substring(0, 32)}`;
  }

  /**
   * Returns the public machine descriptor.
   * @returns {import('./descriptor.mjs').MachineDescriptor}
   */
  getDescriptor() {
    if (!this.hardwareId || !this.publicKeyHex) {
      throw new Error("MachineIdentity not initialized");
    }
    return {
      hardwareId: this.hardwareId,
      machineKeyPub: this.publicKeyHex,
      generation: "gen_1" // TODO: Wire to machine generation from SQLite
    };
  }

  /**
   * Cryptographically signs a payload to prove machine possession.
   * Execution happens entirely inside the native OS boundary.
   * @param {Buffer} payload 
   * @returns {string} Hex signature
   */
  signPayload(payload) {
    if (!this.publicKeyHex) {
      throw new Error("MachineIdentity not initialized");
    }
    return NativeCore.signMachinePayload(payload);
  }
}

export const machineIdentity = new MachineIdentity();
