export class DiskSpaceGuard {
  constructor(maxFileSize) {
    this.maxFileSize = maxFileSize;
  }

  check(declaredSize) {
    if (declaredSize !== null && declaredSize !== undefined) {
      if (declaredSize > this.maxFileSize) {
        throw new Error(`StorageError: Declared size ${declaredSize} exceeds maximum allowed size ${this.maxFileSize}`);
      }
    }
    // We could add OS-level disk space checking here using statfs in the future.
    // For now, we just enforce the max file size soft limit.
  }
}
