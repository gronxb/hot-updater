// Private real HTTP installer QA; these receipts do not assert catalog authorization.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const [udid] = process.argv.slice(2);
assert(udid, 'Reserved simulator UDID required');
const ios = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(ios, '../../..');
const app = 'com.hotupdater.lynxexample';
const run = (cmd,args)=>execFileSync(cmd,args,{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024});
const device = args=>JSON.parse(run('agent-device',[...args,'--session','lynx-ios','--json']));
const data = run('xcrun',['simctl','get_app_container',udid,app,'data']).trim();
const installed = run('xcrun',['simctl','get_app_container',udid,app,'app']).trim();
const home = path.join(data,'Library/Application Support/HotUpdaterLynxSpike');
const output = path.join(ios,'.probe-results',`${Date.now()}-artifact`);
await fs.mkdir(output,{recursive:true});
const json = async file=>JSON.parse(await fs.readFile(file,'utf8'));
const events = async()=> (await fs.readFile(path.join(home,'events.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
const close = ()=>device(['close',app]);
const result=[];
async function open(name, selection, flags=[], expected='confirmed') {
  close();
  if(selection) await fs.writeFile(path.join(home,'launch.json'),JSON.stringify(selection));
  const offset=(await events()).length;
  assert(device(['open',app,'--platform','ios','--udid',udid,'--foreground',...flags.map(f=>`--launch-args=${f}`)]).success);
  let rows=[];
  for(let n=0;n<100;n++) {
    rows=(await events()).slice(offset);
    if(rows.some(r=>r.event===expected))break;
    await new Promise(r=>setTimeout(r,200));
  }
  await fs.writeFile(path.join(output,name+'.events.json'),JSON.stringify(rows,null,2));
  assert(rows.some(r=>r.event===expected), `${name} missing ${expected}: ${JSON.stringify(rows)}`);
  const snapshot=device(['snapshot','-i']);
  await fs.writeFile(path.join(output,name+'.snapshot.json'),JSON.stringify(snapshot,null,2));
  result.push({name,events:rows.map(r=>r.event)});
  process.stdout.write(name+': '+rows.map(r=>r.event).join(', ')+'\n');
  return rows;
}
const embedded=async framework=>({...await json(path.join(installed,'Embedded',framework+'-A.json')),scope:'g1-'+framework});
for(const [framework,receipt,mode] of [
 ['react','react-ios','unsigned'], ['vue','vue-ios','unsigned'], ['octane','octane-ios','unsigned'],
 ['react','react-ios-signed','signed'],
 ['react','react-ios-B-external2-managed-tar-gz-signed','signed'],
 ['react','react-ios-B-external2-managed-tar-br-signed','signed']
]) {
 const a=await embedded(framework);
 await open(receipt+'-A',a);
 const rows=await open(receipt+'-prepare',a,[`--artifact-url=http://127.0.0.1:18791/receipts/${receipt}.json`,...(mode==='signed'?['--artifact-signed']:[])],'artifactStaged');
 const staged=rows.find(r=>r.event==='artifactStaged');
 assert.equal(staged.activeReleaseId,a.releaseId);
 const selection=await json(path.join(home,'launch.json'));
 assert.equal(selection.artifactStore,mode);
 assert.equal(selection.bundleId,staged.candidateBundleId);
 const loaded=await open(receipt+'-restart',null);
 assert(loaded.some(r=>r.event==='processSelected' && r.root.includes('/artifact-store-'+mode+'/bundles/'+selection.bundleId)));
 for(const resource of ['assets/probe.png','assets/probe.ttf','assets/bootstrap.js']) assert(loaded.some(r=>r.path===resource && r.event==='resourceValidated'),resource);
 device(['screenshot',path.join(output,receipt+'.png')]);
}
const a=await embedded('react');
await open('revoked-A',a);
const revoked=await open('revoked-prepare',a,['--artifact-url=http://127.0.0.1:18791/receipts/react-ios.json','--artifact-revoke'],'artifactRejected');
assert(revoked.some(r=>r.event==='artifactPrepared'));
assert.equal((await json(path.join(home,'launch.json'))).bundleId,a.bundleId);
await open('configured-key-unsigned',a,['--artifact-url=http://127.0.0.1:18791/receipts/react-ios.json','--artifact-signed'],'artifactRejected');
await open('interrupted-prepared',a,['--artifact-url=http://127.0.0.1:18791/receipts/react-ios.json','--artifact-hold'],'artifactPrepared');
assert((await fs.readdir(path.join(home,'artifact-store-unsigned/.staging'))).length>0);
close();
await open('interrupted-recovery',null,['--artifact-url=http://127.0.0.1:18791/receipts/react-ios.json','--artifact-revoke'],'artifactRejected');
// Reopening the exclusive store removes the abandoned process's stage. Only this process's rejected preparation remains.
assert.equal((await fs.readdir(path.join(home,'artifact-store-unsigned/.staging'))).length,1);
assert.equal((await json(path.join(home,'launch.json'))).bundleId,a.bundleId);
const binaryHash=createHash('sha256').update(await fs.readFile(path.join(installed,'SparklingGo'))).digest('hex');
await fs.writeFile(path.join(output,'summary.json'),JSON.stringify({binaryHash,results:result},null,2));
process.stdout.write(JSON.stringify({output,binaryHash,passed:result.length})+'\n');
