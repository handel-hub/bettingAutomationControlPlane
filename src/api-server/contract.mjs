// @ts-check

import { securityFacade } from '../security-authority/facade.mjs';

/**
 * Defines the strict API contracts exposed by the Control Plane.
 */
export const ApiContract = {
  /**
   * @param {any} req 
   * @param {any} res 
   */
  async handleAuthentication(req, res) {
    try {
      const credentials = req.body;
      const result = await securityFacade.authenticate(credentials);
      
      if (result.status === "OPERATIONAL") {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: "Authenticated successfully" }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: result.message }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: "Internal Security Fault" }));
    }
  }
};
