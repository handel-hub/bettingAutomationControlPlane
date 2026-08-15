// @ts-check

/**
 * Manages the canonical user identity context.
 */
export class UserIdentity {
  constructor() {
    /** @type {import('./descriptor.mjs').UserDescriptor | null} */
    this.descriptor = null;
  }

  /**
   * Sets the active user context post-authentication.
   * @param {import('./descriptor.mjs').UserDescriptor} descriptor 
   */
  setIdentity(descriptor) {
    this.descriptor = descriptor;
  }

  /**
   * @returns {import('./descriptor.mjs').UserDescriptor | null}
   */
  getIdentity() {
    return this.descriptor;
  }

  clear() {
    this.descriptor = null;
  }
}

export const userIdentity = new UserIdentity();
