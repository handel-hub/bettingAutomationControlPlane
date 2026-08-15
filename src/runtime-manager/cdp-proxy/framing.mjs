// @ts-check

/**
 * Handles the secure framing and encapsulation of Chrome DevTools Protocol 
 * messages traversing the IPC boundary.
 */
export class CdpFraming {
  /**
   * Encapsulates a raw CDP message into a secure Control Plane frame.
   * @param {string} payload 
   * @returns {string} JSON frame
   */
  frame(payload) {
    return JSON.stringify({
      type: "CDP_TUNNEL",
      payload,
      timestamp: Date.now()
    });
  }

  /**
   * Extracts and validates a raw CDP message from a Control Plane frame.
   * @param {string} frame 
   * @returns {string | null}
   */
  unframe(frame) {
    try {
      const parsed = JSON.parse(frame);
      if (parsed.type === "CDP_TUNNEL" && parsed.payload) {
        return parsed.payload;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const cdpFraming = new CdpFraming();
