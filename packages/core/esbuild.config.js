import {build} from 'esbuild';
import packageJson from './package.json' assert { type: 'json' } ;
// const {build} = require('esbuild');
// const fs = require('fs');
// const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
Promise.all([
    build({
        entryPoints: ['src/index.ts'],
        bundle:true,
        platform: "neutral",
        outfile: 'dist/index.js',
        external: Object.keys({
            ...packageJson.dependencies,
            ...packageJson.devDependencies
        }),
    }),
   
]).then(() => {
    console.log('Build complete');
});
