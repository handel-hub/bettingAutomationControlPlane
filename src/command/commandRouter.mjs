import { logger } from '../shared/logging.mjs';
import { EventEmitter } from 'node:events';
import { CommandPayloadSchema, ContractViolationError } from './commandSchema.mjs';
import { CAPABILITY } from '../security-authority/authorization/capabilities.mjs';
import { securityFacade } from '../security-authority/facade.mjs';

export const COMMAND_CAPABILITY_MAP = Object.freeze({
    'START_AUTOMATION': CAPABILITY.AUTOMATION_START,
    'STOP_AUTOMATION': CAPABILITY.AUTOMATION_STOP,
    'UPDATE_GLOBAL_CONFIG': CAPABILITY.CONFIG_MODIFY
});

/**
 * Authoritative Ingress Gateway for routing IPC/WebSocket/REST command payloads.
 * Enforces CommandPayloadSchema contracts and tracks ingress telemetry metrics.
 */
export class CommandRouter extends EventEmitter {
    constructor(scheduler = null, flagManager = null, security = null) {
        super();
        this.handlers = new Map();
        this._metrics = {
            received: 0,
            rejected: 0,
            routed: 0
        };
        this.featureFlagManager = flagManager;
        this.security = security;
    }

    /**
     * Returns a snapshot of ingress metrics.
     * @returns {{ received: number, rejected: number, routed: number }}
     */
    getIngressMetrics() {
        return { ...this._metrics };
    }

    /**
     * Helper to safely parse raw incoming payloads (string or object).
     * @param {string | object} raw - Raw payload
     * @returns {object | null} Parsed object or null if parsing fails
     * @private
     */
    _parsePayload(raw) {
        if (!raw) return null;
        if (typeof raw === 'object') return raw;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw);
            } catch (err) {
                logger.warn(`[CommandRouter] Failed to parse JSON payload string: ${err.message}`);
                return null;
            }
        }
        return null;
    }

    /**
     * Helper to emit structural violation telemetry and log error.
     * @param {string} errorMsg - Violation description
     * @param {object} payload - The offending command payload
     * @private
     */
    _emitViolation(errorMsg, payload) {
        logger.warn({
            event: 'LF_701_VIOLATION',
            code: 'LF-701',
            commandId: payload?.id || payload?.commandId || 'unknown',
            message: errorMsg
        }, `[CommandRouter] [LF-701] Ingress Contract Violation`);
    }

    /**
     * Helper to negotiate wire protocol version from headers or payload.
     * @param {object} headersOrPayload - Headers map or command payload
     * @returns {string} Protocol version ('3.0' or '2.0')
     * @private
     */
    _negotiateVersion(headersOrPayload) {
        if (!headersOrPayload || typeof headersOrPayload !== 'object') return '2.0';
        const version = headersOrPayload['X-AGY-Protocol-Version'] || 
                        headersOrPayload._protocolVersion || 
                        headersOrPayload.version || 
                        headersOrPayload.protocolVersion;
        if (version && String(version).startsWith('3.')) {
            return '3.0';
        }
        return '2.0';
    }

    /**
     * Registers a command handler for a category and type.
     * @param {string} category 
     * @param {string} type 
     * @param {Function} handler 
     */
    register(category, type, handler) {
        if (!this.handlers.has(category)) {
            this.handlers.set(category, new Map());
        }
        const categoryMap = this.handlers.get(category);
        
        if (!categoryMap.has(type)) {
            categoryMap.set(type, []);
        }
        categoryMap.get(type).push(handler);
    }

    /**
     * Ingests, validates, and routes an incoming command to registered handlers.
     * @param {string | object} rawCommand - Incoming command payload
     * @param {object} [headers] - Optional wire headers for protocol version negotiation
     * @returns {Promise<{ success: boolean, results: any[] }>}
     */
    async route(rawCommand, headers = null) {
        this._metrics.received++;

        let command = this._parsePayload(rawCommand);
        if (!command || typeof command !== 'object') {
            this._metrics.rejected++;
            const errorMsg = '[LF-701] Ingress Contract Violation: Malformed JSON or non-object payload';
            this._emitViolation(errorMsg, { id: 'unparseable' });
            logger.error(`[CommandRouter] STRICT mode rejecting unparseable payload: ${errorMsg}`);
            throw new ContractViolationError(errorMsg);
        }

        const protocolVersion = this._negotiateVersion(headers || command);
        logger.debug(`[CommandRouter] Negotiated protocol version: ${protocolVersion}`);

        if (!command.category && !command.type) {
            this._metrics.rejected++;
            logger.warn('Received invalid command object without category or type');
            this.emit('rejected', { command, reason: 'Missing category and type', headers });
            return { success: false, results: [] };
        }

        if (!Object.isExtensible(command)) {
            command = { ...command };
        }

        if (!command.id && !command.commandId) {
            command.id = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        }
        if (!command.commandId) {
            command.commandId = command.id;
        }
        if (!command.traceId) {
            command.traceId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        }

        // Ingress Contract Gating
        const validation = CommandPayloadSchema.validate(command);
        if (!validation.valid) {
            const errorMsg = `[LF-701] Ingress Contract Violation (${command.id || command.commandId || 'unknown'}): ${validation.errors.join('; ')}`;
            this._emitViolation(errorMsg, command);
            
            this._metrics.rejected++;
            logger.error(`[CommandRouter] STRICT mode rejecting command: ${errorMsg}`);
            this.emit('rejected', { command, reason: 'Schema Validation Failed (STRICT)', headers });
            throw new ContractViolationError(errorMsg, { errors: validation.errors });
        }

        // Ingress Capability Validation
        const requiredCap = COMMAND_CAPABILITY_MAP[command.type];
        const sec = this.security || (this === commandRouter ? securityFacade : null);
        if (requiredCap && sec && typeof sec.authorize === 'function') {
            const authResult = sec.authorize(requiredCap);
            if (authResult && authResult.status !== 'OPERATIONAL') {
                const errorMsg = `[LF-701] Execution Denied: Missing required capability [${requiredCap}]`;
                this._emitViolation(errorMsg, command);
                this._metrics.rejected++;
                logger.error(`[CommandRouter] Capability check failed for ${command.type}: ${errorMsg}`);
                this.emit('rejected', { command, reason: errorMsg, headers });
                throw new ContractViolationError(errorMsg);
            }
        }

        const category = command.category || (command.type === 'NAVIGATE' || command.type === 'navigate' ? 'Navigation' : 'Execution');
        const categoryMap = this.handlers.get(category);
        if (!categoryMap) {
            logger.debug(`No handlers registered for category [${category}]`);
            return { success: false, results: [] };
        }

        const exactHandlers = categoryMap.get(command.type) || [];
        const wildcardHandlers = categoryMap.get('*') || [];
        const allHandlers = [...exactHandlers, ...wildcardHandlers];

        if (allHandlers.length === 0) {
            logger.error(`[Telemetry] {"event":"UNHANDLED_COMMAND_DROPPED","commandId":"${command.id}","category":"${category}","type":"${command.type}"}`);
            return { success: false, results: [] };
        }

        logger.info(`[CommandRouter] Routing [${category}:${command.type}] (${command.id || command.commandId}) [Protocol v${protocolVersion}]`);
        
        this.emit('routed', {
            command,
            category,
            protocolVersion,
            handlers: allHandlers.length,
            headers
        });

        const results = [];
        for (const handler of allHandlers) {
            try {
                const res = await handler(command);
                results.push(res);
            } catch (err) {
                logger.error(`Error in Command handler for [${category}:${command.type}]: ${err.message}`);
                throw err;
            }
        }

        this._metrics.routed++;
        return { success: true, results };
    }
}

export const commandRouter = new CommandRouter();

