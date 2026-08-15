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
    
    // Derive deterministic hardware identifier based on public key hash or securely from Rust
    // For now we just use a securely generated native random ID to match previous interface
    // In production, this should ideally be derived natively from the DPAPI material
    this.hardwareId = `hw_${NativeCore.secureRandom(16).toString('hex')}`;
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
      generation: "gen_1"
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
