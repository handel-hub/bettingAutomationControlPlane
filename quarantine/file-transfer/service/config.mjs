export function mergeConfig(userConfig = {}) {
  const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB
  const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB
  const DEFAULT_MAX_CONCURRENT_TRANSFERS = 3;
  const DEFAULT_MAX_CONCURRENT_CHUNK_UPLOADS = 4;
  
  if (!userConfig.dataDir) {
    throw new Error('FTS Configuration Error: dataDir is required.');
  }
  
  if (!userConfig.backendTransferClient) {
    throw new Error('FTS Configuration Error: backendTransferClient is required.');
  }

  return {
    dataDir: userConfig.dataDir,
    backendTransferClient: userConfig.backendTransferClient,
    chunkSize: userConfig.chunkSize || DEFAULT_CHUNK_SIZE,
    maxFileSize: userConfig.maxFileSize || DEFAULT_MAX_FILE_SIZE,
    maxConcurrentTransfers: userConfig.maxConcurrentTransfers || DEFAULT_MAX_CONCURRENT_TRANSFERS,
    maxConcurrentChunkUploads: userConfig.maxConcurrentChunkUploads || DEFAULT_MAX_CONCURRENT_CHUNK_UPLOADS,
    verifyOnRecovery: userConfig.verifyOnRecovery ?? false,
    retryPolicy: {
      hotBaseMs: userConfig.retryPolicy?.hotBaseMs || 500,
      hotFactor: userConfig.retryPolicy?.hotFactor || 2,
      hotMaxMs: userConfig.retryPolicy?.hotMaxMs || 60000,
      hotMaxAttempts: userConfig.retryPolicy?.hotMaxAttempts || 8,
      coldIntervalMs: userConfig.retryPolicy?.coldIntervalMs || 10 * 60 * 1000, // 10 minutes
      coldMaxDurationMs: userConfig.retryPolicy?.coldMaxDurationMs || 24 * 60 * 60 * 1000, // 24 hours
    },
    cleanupPolicy: {
      retentionMs: userConfig.cleanupPolicy?.retentionMs || 7 * 24 * 60 * 60 * 1000, // 7 days
    },
    timeouts: {
      uploadChunkMs: userConfig.timeouts?.uploadChunkMs || 30000,
      initializeTransferMs: userConfig.timeouts?.initializeTransferMs || 15000,
      completeTransferMs: userConfig.timeouts?.completeTransferMs || 15000,
      queryTransferStatusMs: userConfig.timeouts?.queryTransferStatusMs || 15000,
    }
  };
}
