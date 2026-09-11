// Actual public SDK actions; no candidate placement or native selection injection.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const [udid,variant='sdk1']=process.argv.slice(2); assert(udid);
const ios=path.dirname(fileURLToPath(import.meta.url)); const repo=path.resolve(ios,'../../..');
const app='com.hotupdater.lynxexample';
const exec=(cmd,args)=>execFileSync(cmd,args,{cwd:repo,encoding:'utf8',maxBuffer:12*1024*1024});
const device=args=>JSON.parse(exec('agent-device',[...args,'--session','lynx-ios','--json']));
const data=exec('xcrun',['simctl','get_app_container',udid,app,'data']).trim();
const installed=exec('xcrun',['simctl','get_app_container',udid,app,'app']).trim();
const home=path.join(data,'Library/Application Support/HotUpdaterLynxPublic');
const output=path.join(ios,'.probe-results',`${Date.now()}-public-${variant}`); await fs.mkdir(output,{recursive:true});
const events=async()=> (await fs.readFile(path.join(home,'events.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
async function waitLabel(text) {
 let snapshot;
 for(let n=0;n<30;n++) {
  snapshot=device(['snapshot','-i']);
  if(snapshot.data.nodes.some(row=>row.label?.includes(text)))return snapshot;
  const failure=snapshot.data.nodes.find(row=>/failed:|failure:/i.test(row.label??''));
  if(failure)throw Error(failure.label);
  await new Promise(r=>setTimeout(r,200));
 }
 throw Error(`Missing ${text}: ${JSON.stringify(snapshot)}`);
}
async function state(framework) {
 const candidates=[];
 for(const name of await fs.readdir(path.join(home,'stores'))) {
  const file=path.join(home,'stores',name,'state.json');
  const value=JSON.parse(await fs.readFile(file,'utf8').catch(()=>'{"skip":true}')); if(value.skip)continue;
  const raw=value.confirmed?.receipt??value.next?.receipt;
  if(raw && JSON.parse(Buffer.from(raw,'base64')).channel==='ota-'+framework)candidates.push({file,value,mtime:(await fs.stat(file)).mtimeMs});
 }
 candidates.sort((a,b)=>b.mtime-a.mtime); assert(candidates.length); return candidates[0];
}
const results=[];
for(const framework of ['react','vue','octane']) {
 device(['close',app]); const offset=(await events()).length;
 device(['open',app,'--platform','ios','--udid',udid,'--foreground',`--launch-args=--ota-framework=${framework}`]);
 await waitLabel('Bundle A ready');
 const before=await state(framework); assert(!before.value.next);
 device(['find','Check update','click']); await waitLabel('Update verified and ready to install.');
 const prepared=await state(framework); assert(!prepared.value.next);
 assert.equal((await fs.readdir(path.join(path.dirname(prepared.file),'bundles'))).length,0);
 assert((await fs.readdir(path.join(path.dirname(prepared.file),'.staging'))).length>0);
 device(['screenshot',path.join(output,framework+'-prepared.png')]);
 device(['find','Install next launch','click']); await waitLabel('Update installed. Close and reopen the app.');
 const staged=await state(framework); assert(staged.value.next);
 const receipt=JSON.parse(Buffer.from(staged.value.next.receipt,'base64'));
 const confirmed=JSON.parse(Buffer.from(staged.value.confirmed.receipt,'base64'));
 assert.equal(confirmed.kind,'BUILTIN'); assert.equal(receipt.kind,'BUNDLE');
 device(['screenshot',path.join(output,framework+'-staged.png')]);
 device(['close',app]);
 device(['open',app,'--platform','ios','--udid',udid,'--foreground',`--launch-args=--ota-framework=${framework}`]);
 await waitLabel('Bundle B ready');
 const launched=await state(framework); assert(!launched.value.pending);
 assert.equal(JSON.parse(Buffer.from(launched.value.confirmed.receipt,'base64')).releaseId,receipt.releaseId);
 device(['screenshot',path.join(output,framework+'-B.png')]);
 const rows=(await events()).slice(offset);
 assert(rows.some(row=>row.event==='publicBeforeEvaluation' && row.state.runningSelection.releaseId===receipt.releaseId));
 await fs.writeFile(path.join(output,framework+'.events.json'),JSON.stringify(rows,null,2));
 await fs.writeFile(path.join(output,framework+'.state.json'),JSON.stringify(launched.value,null,2));
 results.push({framework,receipt,events:rows.map(r=>r.event)});
 console.log(framework,'public check/prepare → install → restart B passed',receipt.releaseId);
}
const binaryHash=createHash('sha256').update(await fs.readFile(path.join(installed,'SparklingGo'))).digest('hex');
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({binaryHash,results},null,2));
console.log(JSON.stringify({output,binaryHash,passed:results.length}));
