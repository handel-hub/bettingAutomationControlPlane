import fs from 'fs';
import path from 'path';

const dir = './test/adversarial';
const files = fs.readdirSync(dir);

for (const file of files) {
  if (file.endsWith('.test.mjs')) {
    const p = path.join(dir, file);
    let content = fs.readFileSync(p, 'utf8');
    
    content = content.replace(/import \{ StorageAdapterNativeWrapper \} from '..\/..\/native\/security-core\.mjs';/g, 
      "import { StorageAdapter } from '../../persistence/storage-adapter.mjs';");
    content = content.replace(/StorageAdapterNativeWrapper/g, 'StorageAdapter');
    content = content.replace(/function setupDb/g, 'async function setupDb');
    content = content.replace(/StorageAdapter\.initDatabase/g, 'await StorageAdapter.initDatabase');
    content = content.replace(/setupDb\(/g, 'await setupDb(');
    
    content = content.replace(/import \{ CryptoProviderNativeWrapper \} from '..\/..\/crypto\/bindings\.mjs';/g, 
      "import { NativeCore } from '../../native/security-core.mjs';");
    content = content.replace(/CryptoProviderNativeWrapper/g, 'NativeCore');
    
    fs.writeFileSync(p, content);
  }
}

// also state-machine.test.mjs
let content = fs.readFileSync('./test/state-machine.test.mjs', 'utf8');
content = content.replace(/import \{ StorageAdapterNativeWrapper \} from '\.\.\/native\/security-core\.mjs';/g, 
      "import { StorageAdapter } from '../persistence/storage-adapter.mjs';");
content = content.replace(/StorageAdapterNativeWrapper/g, 'StorageAdapter');
content = content.replace(/function setupDb/g, 'async function setupDb');
content = content.replace(/StorageAdapter\.initDatabase/g, 'await StorageAdapter.initDatabase');
content = content.replace(/setupDb\(/g, 'await setupDb(');
fs.writeFileSync('./test/state-machine.test.mjs', content);
