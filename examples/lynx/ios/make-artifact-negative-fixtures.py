"""Negative-only HTTP fixtures derived from an actual CLI archive; not catalog publications."""
import hashlib, io, json, pathlib, struct, subprocess, tarfile, urllib.request, uuid, warnings, zipfile

repo = pathlib.Path(__file__).resolve().parents[3]
output = repo / 'examples/lynx/.hot-updater/ota/objects/qa/ios'
output.mkdir(parents=True, exist_ok=True)
receipt = json.load(urllib.request.urlopen('http://127.0.0.1:18791/receipts/react-ios.json'))
original = urllib.request.urlopen(receipt['fileUrl']).read()
with zipfile.ZipFile(io.BytesIO(original)) as archive:
    files = {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
index = []
def emit(name, data, expected, token=None):
    (output / (name + '.archive')).write_bytes(data)
    index.append({'name': name, 'expected': expected, 'request': {'bundleId': receipt['bundleId'], 'fileUrl': 'http://127.0.0.1:18791/files/qa/ios/' + name + '.archive', 'fileHash': token or hashlib.sha256(data).hexdigest(), 'manifestFileHash': None}})
def zipped(items):
    target = io.BytesIO()
    with warnings.catch_warnings(), zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        warnings.simplefilter('ignore', UserWarning)
        for name, data in items: archive.writestr(name, data)
    return target.getvalue()
def metadata_case(name, change):
    changed = dict(files)
    metadata = json.loads(changed['hot-updater-lynx.json']); change(metadata)
    changed['hot-updater-lynx.json'] = json.dumps(metadata).encode()
    manifest = json.loads(changed['manifest.json'])
    manifest['assets']['hot-updater-lynx.json']['fileHash'] = hashlib.sha256(changed['hot-updater-lynx.json']).hexdigest()
    changed['manifest.json'] = json.dumps(manifest).encode()
    emit(name, zipped(changed.items()), 'metadata')
emit('hash-mismatch', original, 'FILE_HASH_MISMATCH', '0' * 64)
emit('truncated-zip', original[:len(original)//2], 'archive')
metadata_case('wrong-runtime', lambda m: m.update(runtimeId='incompatible-native-runtime'))
metadata_case('wrong-platform', lambda m: m.update(platform='android'))
metadata_case('boolean-schema', lambda m: m.update(schemaVersion=True))
metadata_case('missing-schema', lambda m: m.pop('schemaVersion'))
metadata_case('unsupported-schema', lambda m: m.update(schemaVersion=2))
metadata_case('metadata-bundle-mismatch', lambda m: m.update(bundleId=str(uuid.uuid4())))
metadata_case('entry-traversal', lambda m: m.update(entry='../main.lynx.bundle'))
for name, extra in [('unlisted-file', 'extra.js'), ('traversal', '../outside.txt'), ('absolute', '/outside.txt'), ('case-alias', 'MAIN.LYNX.BUNDLE'), ('file-directory-conflict', 'assets')]:
    emit(name, zipped(list(files.items()) + [(extra, b'rejected')]), 'archive-or-allowlist')
emit('duplicate-entry', zipped(list(files.items()) + [('main.lynx.bundle', b'duplicate')]), 'archive')
link = zipfile.ZipInfo('link'); link.create_system = 3; link.external_attr = 0o120777 << 16
emit('symbolic-link', zipped(list(files.items()) + [(link, b'../outside')]), 'archive')
changed = dict(files); changed['assets/probe.png'] += b'corrupt'
emit('asset-hash-mismatch', zipped(changed.items()), 'FILE_HASH_MISMATCH')
changed = dict(files); changed.pop('main.lynx.bundle')
emit('missing-entry', zipped(changed.items()), 'missing-file')
changed = dict(files); changed['main.lynx.bundle'] = b''
manifest = json.loads(changed['manifest.json']); manifest['assets']['main.lynx.bundle']['fileHash'] = hashlib.sha256(b'').hexdigest()
changed['manifest.json'] = json.dumps(manifest).encode()
emit('empty-entry', zipped(changed.items()), 'metadata')
changed = dict(files); manifest = json.loads(changed['manifest.json']); manifest['bundleId'] = str(uuid.uuid4()); changed['manifest.json'] = json.dumps(manifest).encode()
emit('manifest-bundle-mismatch', zipped(changed.items()), 'manifest')
# Central-directory declared size deliberately understates valid compressed output.
bomb = bytearray(zipped([('payload.bin', b'x' * 1024 * 1024)]))
central = bomb.index(b'PK\x01\x02'); struct.pack_into('<I', bomb, central + 24, 1)
emit('understated-deflate-size', bytes(bomb), 'archive')
for kind in ['traversal', 'symlink', 'hardlink', 'duplicate']:
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode='w:gz') as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); archive.addfile(info, io.BytesIO(data))
        info = tarfile.TarInfo('../outside' if kind == 'traversal' else 'main.lynx.bundle' if kind == 'duplicate' else 'link')
        if kind in ['symlink', 'hardlink']:
            info.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE; info.linkname = '../outside'; archive.addfile(info)
        else:
            data = b'rejected'; info.size = len(data); archive.addfile(info, io.BytesIO(data))
    emit('tar-' + kind, target.getvalue(), 'archive')
# Tiny malformed PAX bodies must reject without integer/range traps.
for name, payload in [('pax-short', b'1 a=b\n'), ('pax-overflow', b'6 a=b\n9223372036854775807 a=b\n')]:
    target = io.BytesIO()
    with tarfile.open(fileobj=target, mode='w:gz') as archive:
        info = tarfile.TarInfo('pax'); info.type = tarfile.XHDTYPE; info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
    emit(name, target.getvalue(), 'archive')
for name, metadata_bytes in [('oversized-sidecar', files['hot-updater-lynx.json'] + b' ' * (16 * 1024)), ('duplicate-entry-key', files['hot-updater-lynx.json'][:-1] + b',"entry":"evil.js"}'), ('deep-sidecar', b'[' * 33 + b'0' + b']' * 33)]:
    changed = dict(files); changed['hot-updater-lynx.json'] = metadata_bytes
    manifest = json.loads(changed['manifest.json']); manifest['assets']['hot-updater-lynx.json']['fileHash'] = hashlib.sha256(metadata_bytes).hexdigest()
    changed['manifest.json'] = json.dumps(manifest).encode(); emit(name, zipped(changed.items()), 'metadata')
for name, manifest_bytes in [('oversized-manifest', files['manifest.json'] + b' ' * (16 * 1024 * 1024)), ('duplicate-bundle-key', files['manifest.json'].rstrip()[:-1] + b',"bundleId":"conflict"}'), ('duplicate-asset-hash-key', files['manifest.json'].replace(b'"fileHash":', b'"fileHash":"conflict","fileHash":', 1))]:
    changed = dict(files); changed['manifest.json'] = manifest_bytes; emit(name, zipped(changed.items()), 'metadata')
for name, offset, value in [('zip-count-limit', -12, 10001), ('zip-name-limit', None, 1025)]:
    changed = bytearray(original)
    at = changed.rfind(b'PK\x05\x06') + 10 if offset else changed.index(b'PK\x01\x02') + 28
    struct.pack_into('<H', changed, at, value); emit(name, bytes(changed), 'archive')
(output / 'index.json').write_text(json.dumps(index, indent=2) + '\n')
print(f'Wrote {len(index)} negative fixtures: {output}')
