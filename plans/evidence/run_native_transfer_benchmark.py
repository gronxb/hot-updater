#!/usr/bin/env python3
"""Run actual Swift installers on one dedicated iOS simulator over delayed HTTP.
Arguments: fixtures output, simulator UDID, archive worktree, manifest worktree.
Temporarily injects a test and resources, restoring both worktrees in finally.
"""
import argparse
import functools
import http.server
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
for name in ['inputs', 'device', 'archive_root', 'manifest_root']: parser.add_argument(name)
parser.add_argument('--manifest-label', default='manifest')
parser.add_argument('--only', choices=['archive', 'manifest'])
args = parser.parse_args()
inputs, device, archive_root, manifest_root = args.inputs, args.device, args.archive_root, args.manifest_root
inputs = Path(inputs)
template = Path(__file__).with_name('NativeTransferBenchmark.swift').read_text()
class Server(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        time.sleep(.020)
        super().do_GET()
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Server, directory=str(inputs/'http')))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
rows = []
try:
    for kind, root in [('archive', archive_root), ('manifest', manifest_root)]:
        if args.only and args.only != kind: continue
        protocol = args.manifest_label if kind == 'manifest' else 'archive'
        package = Path(root)/'packages/react-native/ios/HotUpdater'
        test = package/'Test/BundleFileStorageServiceTests.swift'
        package_file = package/'Package.swift'
        resources = package/'Test/NativeTransferFixtures'
        old_test, old_package = test.read_text(), package_file.read_text()
        if resources.exists(): raise RuntimeError('Refusing to overwrite existing benchmark resources')
        try:
            shutil.copytree(inputs/'fixtures', resources)
            injected = template.replace('__BASE_URL__', f'http://127.0.0.1:{server.server_port}').replace('__PROTOCOL__', protocol)
            test.write_text(old_test.replace('\n#endif', '\n'+injected+'\n#endif'))
            resource_package = old_package
            test_target_start = resource_package.rfind('.testTarget(')
            test_target_end = resource_package.index('\n        )', test_target_start)
            resource_package = resource_package[:test_target_end].rstrip().rstrip(',') + ',\n            sources: ["BundleFileStorageServiceTests.swift"],\n            resources: [.copy("NativeTransferFixtures")]' + resource_package[test_target_end:]
            package_file.write_text(resource_package)
            command = ['xcodebuild', 'test', '-scheme', 'HotUpdater', '-destination', f'platform=iOS Simulator,id={device}',
                       '-derivedDataPath', str(inputs/f'derived-{protocol}'), '-parallel-testing-enabled', 'NO',
                       '-only-testing:HotUpdaterTest/NativeTransferBenchmark', 'CODE_SIGNING_ALLOWED=NO', 'IPHONEOS_DEPLOYMENT_TARGET=15.0']
            with (inputs/f'{protocol}.log').open('w') as log:
                result = subprocess.run(command, cwd=package, stdout=log, stderr=subprocess.STDOUT)
            if result.returncode: raise RuntimeError(f'{protocol} failed; inspect {inputs/protocol}.log')
            for line in (inputs/f'{protocol}.log').read_text().splitlines():
                if 'NATIVE_TRANSFER_RESULT ' in line:
                    rows.append(json.loads(line.split('NATIVE_TRANSFER_RESULT ',1)[1]))
            if sum(row['protocol'] == protocol for row in rows) != 20:
                raise RuntimeError(f'{protocol}: expected 4 scenarios x 5 runs')
        finally:
            test.write_text(old_test)
            package_file.write_text(old_package)
            shutil.rmtree(resources)
finally:
    server.shutdown()

summary=[]
for protocol in sorted(set(row['protocol'] for row in rows)):
    for name in sorted(set(row['scenario'] for row in rows)):
        group=[row for row in rows if row['protocol']==protocol and row['scenario']==name]
        summary.append({'protocol':protocol, 'scenario':name, **{key:statistics.median(row[key] for row in group) for key in group[0] if key not in ('protocol','scenario','round')}})
result={'environment':{'device':device,'network':'loopback HTTP/1.0, 20 ms server delay per request, no bandwidth cap','samplingMs':50,'rounds':5},'summary':summary,'runs':rows}
result_path = inputs/f'results-{args.manifest_label}.json'
result_path.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'results':str(result_path),'summary':summary},indent=2))
