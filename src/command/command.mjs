import { randomUUID } from 'node:crypto';

function deepFreeze(object) {
    const propNames = Object.getOwnPropertyNames(object);
    for (const name of propNames) {
        const value = object[name];
        if (value && typeof value === "object") {
            deepFreeze(value);
        }
    }
    return Object.freeze(object);
}

export class Command {
    constructor({ 
        category = 'Execution', type, target = null, payload = {}, 
        source, executionMode = 'ALL', metadata = {},
        lifecycle = 'CREATED',
        id, creationTime, traceId, timestamp,
    }) {
        this.lifecycle = lifecycle;
        this.id = id ?? payload.id ?? randomUUID();
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
        if (traceId !== undefined) this.traceId = traceId;

        deepFreeze(this);
    }

    withLifecycle(lifecycle) {
        return new Command({
            ...this,
            payload: this.payload,
            lifecycle
        });
    }

}
