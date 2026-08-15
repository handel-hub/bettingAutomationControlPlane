// @ts-check

/**
 * Provides a strictly monotonic time source independent of OS clock skew.
 * In a real environment, this might sync with a trusted NTP server.
 */
export class SecureTimeSource {
  constructor() {
    this.bootTime = Date.now();
    this.processTimeAtBoot = process.hrtime.bigint();
  }

  /**
   * Returns the current epoch time, shielded from backwards OS clock jumps
   * during this process's lifecycle by using hrtime.
   * @returns {number}
   */
  now() {
    const elapsedNanos = process.hrtime.bigint() - this.processTimeAtBoot;
    const elapsedMs = Number(elapsedNanos / 1000000n);
    return this.bootTime + elapsedMs;
  }
}

export const secureTimeSource = new SecureTimeSource();
