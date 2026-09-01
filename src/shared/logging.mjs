// @ts-check


import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const logger = pino({
    transport: {
        targets: [
            {
                target: 'pino-pretty',
                options: {
                    colorize: true
                }
            },
            {
                target: 'pino/file',
                options: {
                    destination: './logs/app.log',
                    mkdir: true
                }
            }
        ]
    },
    hooks: {
        logMethod(inputArgs, method, level) {
            if (process.env.RKP_PINO_DUAL_WRITE === 'true') {
                try {
                    let msg = '';
                    let meta = {};
                    
                    if (inputArgs.length > 0) {
                        if (typeof inputArgs[0] === 'string') {
                            msg = inputArgs[0];
                        } else if (typeof inputArgs[0] === 'object') {
                            meta = inputArgs[0];
                            if (typeof inputArgs[1] === 'string') {
                                msg = inputArgs[1];
                            }
                        }
                    }

                    let levelStr = 'info';
                    if (level === 20) levelStr = 'debug';
                    else if (level === 40) levelStr = 'warn';
                    else if (level >= 50) levelStr = 'error'; // includes fatal

                    globalRecorder.record({
                        domain: 'Diagnostics',
                        type: 'LogFact',
                        level: levelStr,
                        message: msg,
                        metadata: meta,
                        traceId: meta?.traceId || '',
                        spanId: meta?.spanId || ''
                    });
                } catch (err) {
                    try {
                        const logPath = path.join(__dirname, '..', 'fatal.log');
                        fs.appendFileSync(logPath, `[${new Date().toISOString()}] FATAL [RKP_Serialization_Fault]: ${err.stack || err.message || err}\n`);
                    } catch (e) {}
                    console.error('[RKP Pino Hook] Error:', err);
                }
            }
            return method.apply(this, inputArgs);
        }
    }
});


