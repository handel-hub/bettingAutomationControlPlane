import fs from 'fs';
import path from 'path';
import os from 'os';
import { StorageAdapter } from '../../../persistence/storage-adapter.mjs';

export function getAbsoluteDbPath(dbPath) {
  return path.join(process.cwd(), 'src', 'security-authority', 'test', 'databases', path.basename(dbPath));
}

export async function setupDb(dbPath) {
  const absolutePath = getAbsoluteDbPath(dbPath);
  
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  if (fs.existsSync(absolutePath + '-wal')) fs.unlinkSync(absolutePath + '-wal');
  
  // Reset monotonic counter for testing
  const counterPath = path.join(os.homedir(), 'AppData', 'Roaming', '.security_authority', 'version_counter.bin');
  if (fs.existsSync(counterPath)) {
    try { fs.unlinkSync(counterPath); } catch (e) {}
  }

  // Reset intent log for testing
  const intentPath = path.join(os.homedir(), 'AppData', 'Roaming', '.security_authority', 'intent.bin');
  if (fs.existsSync(intentPath)) {
    try { fs.unlinkSync(intentPath); } catch (e) {}
  }
  
  await StorageAdapter.initDatabase(absolutePath);
  return absolutePath;
}

