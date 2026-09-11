// Embed actual plugin/CLI-validated compiler output using native-only NIL receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const ios=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(ios,'../../..');
const variant=process.argv[2]??'sdk3';
if(!['sdk1','sdk2','sdk3'].includes(variant))throw Error('Expected sdk1, sdk2 or sdk3');
const bundleId='00000000-0000-0000-0000-000000000000';
const runtimeId=`sparkling-c4ce8d2-lynx-3.9.0-primjs-3.8.0-alpha.6-ios-ota-${variant==='sdk3'?'v2':'v1'}`;
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const framework of ['react','vue','octane']) {
 const receipt=JSON.parse(await fs.readFile(path.join(repo,'examples/lynx/.hot-updater/ota/receipts',`${framework}-ios-A-${variant}-managed-embedded.json`),'utf8'));
 if(receipt.runtimeId!==runtimeId || receipt.embeddedBundleId!==bundleId || receipt.minimumBundleId!==bundleId || receipt.catalogMutation!==false)throw Error('Invalid native embedded receipt');
 for(const [name,expected] of Object.entries(receipt.files)) {
  if(hash(await fs.readFile(path.join(receipt.outputPath,name)))!==expected.sha256)throw Error(`Embedded bytes changed: ${name}`);
 }
 const output=path.join(ios,'Embedded/Public',framework);
 await fs.rm(output,{recursive:true,force:true});
 await fs.cp(receipt.outputPath,output,{recursive:true});
 await fs.writeFile(path.join(ios,'Embedded/Public',framework+'-native.json'),JSON.stringify({framework,variant,runtimeId,bundleId,manifestDigest:receipt.manifestFileHash,entry:'main.lynx.bundle'}));
 console.log(framework,variant,receipt.manifestFileHash);
}
