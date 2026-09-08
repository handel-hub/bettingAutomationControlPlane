import { randomUUID } from 'node:crypto';
import { ulid } from 'ulid';

function deepFreeze(object) {
    if (!object || typeof object !== 'object') return object;
    const propNames = Object.getOwnPropertyNames(object);
    for (const name of propNames) {
        const value = object[name];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    }
    return Object.freeze(object);
}

/**
 * @typedef {'Execution' | 'Persistence' | 'Security' | 'Billing' | 'System'} CommandCategory
 * @typedef {'HIGH' | 'NORMAL' | 'LOW'} CommandPriority
 * @typedef {'CREATED' | 'ROUTED' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'REJECTED'} CommandLifecycle
 */

export class Command {
    /**
     * @param {object} params
     * @param {CommandCategory} [params.category='Execution']
     * @param {string} params.type
     * @param {string | null} [params.target=null]
     * @param {Record<string, any>} [params.payload={}]
     * @param {string} [params.source='UI_OPERATOR']
     * @param {string} [params.executionMode='ALL']
     * @param {CommandPriority} [params.priority='NORMAL']
     * @param {Record<string, any>} [params.metadata={}]
     * @param {CommandLifecycle} [params.lifecycle='CREATED']
     * @param {string} [params.id]
     * @param {number} [params.creationTime]
     * @param {string} [params.traceId]
     * @param {number | string} [params.timestamp]
     */
    constructor({ 
        category = 'Execution', 
        type, 
        target = null, 
        payload = {}, 
        source = 'UI_OPERATOR', 
        executionMode = 'ALL', 
        priority = 'NORMAL',
        metadata = {},
        lifecycle = 'CREATED',
        id, 
        creationTime, 
        traceId, 
        timestamp,
    }) {
        this.lifecycle = lifecycle;
        this.id = id ?? payload.id ?? (typeof ulid === 'function' ? ulid() : randomUUID());
        this.category = category;
        this.type = type;
        this.target = target;
        this.payload = payload;
        this.source = source;
        this.executionMode = executionMode;
        this.priority = priority;

        const nowMs = Date.now();
        let ts = timestamp ?? payload.timestamp ?? nowMs;
        if (typeof ts === 'string') {
            const parsed = Number(ts);
            if (!isNaN(parsed) && parsed > 0 && Number.isInteger(parsed)) {
                ts = parsed;
            } else {
                const dt = Date.parse(ts);
                if (!isNaN(dt) && dt > 0) ts = dt;
                else ts = nowMs;
            }
        } else if (typeof ts !== 'number' || isNaN(ts)) {
            ts = nowMs;
        } else {
            ts = Math.round(ts);
        }

        this.timestamp = ts;
        this.creationTime = typeof creationTime === 'number' && !isNaN(creationTime) ? Math.round(creationTime) : nowMs;
        this.metadata = metadata;
        this.traceId = traceId ?? (typeof ulid === 'function' ? ulid() : randomUUID());

        deepFreeze(this);
    }

    /**
     * Creates a new Command instance with updated lifecycle state.
     * @param {CommandLifecycle} lifecycle 
     * @returns {Command}
     */
    withLifecycle(lifecycle) {
        return new Command({
            ...this,
            payload: this.payload,
            metadata: this.metadata,
            lifecycle
        });
    }
}
