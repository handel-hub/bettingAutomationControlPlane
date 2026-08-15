// @ts-check

import { createServer } from 'http';
import { ApiContract } from './contract.mjs';

export class ApiServer {
  constructor() {
    this.server = createServer((req, res) => {
      // Basic routing mapping to strict contracts
      if (req.method === 'POST' && req.url === '/api/v1/authenticate') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
          try {
            req.body = JSON.parse(body);
            ApiContract.handleAuthentication(req, res);
          } catch (e) {
            res.writeHead(400);
            res.end("Bad Request");
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
  }

  /**
   * @param {number} port 
   */
  listen(port = 8443) {
    this.server.listen(port, () => {
      console.log(`[ApiServer] Listening on port ${port}`);
    });
  }
}

export const apiServer = new ApiServer();
