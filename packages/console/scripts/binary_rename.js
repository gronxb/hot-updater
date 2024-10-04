import { execSync } from 'child_process';
import fs from 'fs';

const ext = process.platform === 'win32' ? '.exe' : '';

// aarch64-unknown-linux-gnu	ARM64 Linux (kernel 4.1, glibc 2.17+)
// aarch64-apple-darwin	ARM64 macOS (11.0+, Big Sur+)
// i686-pc-windows-gnu	32-bit MinGW (Windows 10+, Windows Server 2016+) 1
// i686-pc-windows-msvc	32-bit MSVC (Windows 10+, Windows Server 2016+) 1
// i686-unknown-linux-gnu	32-bit Linux (kernel 3.2+, glibc 2.17+) 1
// x86_64-apple-darwin	64-bit macOS (10.12+, Sierra+)
// x86_64-pc-windows-gnu	64-bit MinGW (Windows 10+, Windows Server 2016+)
// x86_64-pc-windows-msvc	64-bit MSVC (Windows 10+, Windows Server 2016+)
// x86_64-unknown-linux-gnu	64-bit Linux (kernel 3.2+, glibc 2.17+)

const rustInfo = execSync('rustc -vV');
const targetTriple = /host: (\S+)/g.exec(rustInfo)[1];
if (!targetTriple) {
  console.error('Failed to determine platform target triple');
}
fs.mkdirSync(`./src-tauri/binaries`, { recursive: true });
fs.renameSync(
  `./sidecar-app/app${ext}`,
  `./src-tauri/binaries/app-${targetTriple}${ext}`
);
