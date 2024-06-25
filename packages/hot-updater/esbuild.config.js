import {build} from 'esbuild';
import packageJson from './package.json' assert { type: 'json' } ;

build({
    entryPoints: ['src/main.ts'],
    bundle:true,
    platform: "node",
    outfile: 'lib/index.cjs',
    external: Object.keys({
        ...packageJson.dependencies,
        ...packageJson.devDependencies
    }),
})