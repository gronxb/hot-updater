// import {build} from 'esbuild';
// import packageJson from './package.json' assert { type: 'json' } ;
const {build} = require('esbuild');
const fs = require('fs');
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
Promise.all([
    build({
        entryPoints: ['src/index.ts'],
        bundle:true,
        platform: "browser",
        outfile: 'dist/index.mjs',
        external: Object.keys({
            ...packageJson.dependencies,
            ...packageJson.devDependencies
        }),
    }),
    build({
        entryPoints: ['src/index.ts'],
        bundle:true,
        platform: "node",
        outfile: 'dist/index.cjs',
        external: Object.keys({
            ...packageJson.dependencies,
            ...packageJson.devDependencies
        }),
    })
]).then(() => {
    console.log('Build complete');
});
