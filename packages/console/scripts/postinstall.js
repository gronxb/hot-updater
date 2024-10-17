// 현재 경로 기준 ../bin/console.app/Contents/MacOS/HotUpdater를 chmod로 +x 권한 부여
import { fileURLToPath } from "url";
import { execSync } from "child_process";

import fs from 'fs';
import path from 'path';

const __dirname = fileURLToPath(import.meta.url);
const binaryPath = path.resolve(__dirname, '../../bin/console.app/Contents/MacOS/HotUpdater');

if (fs.existsSync(binaryPath)) {
    execSync(`chmod +x ${binaryPath}`);
}
