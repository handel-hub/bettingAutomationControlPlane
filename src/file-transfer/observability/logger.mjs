export const logger = {
  info: (msg, meta = {}) => {
    console.log(JSON.stringify({ level: 'INFO', msg, ...meta, timestamp: new Date().toISOString() }));
  },
  warn: (msg, meta = {}) => {
    console.warn(JSON.stringify({ level: 'WARN', msg, ...meta, timestamp: new Date().toISOString() }));
  },
  error: (msg, meta = {}) => {
    // Redact sensitive details if necessary, though FTS shouldn't see credentials
    const safeMeta = { ...meta };
    if (safeMeta.error && safeMeta.error.message) {
       safeMeta.errorMessage = safeMeta.error.message;
       delete safeMeta.error;
    }
    console.error(JSON.stringify({ level: 'ERROR', msg, ...safeMeta, timestamp: new Date().toISOString() }));
  }
};
