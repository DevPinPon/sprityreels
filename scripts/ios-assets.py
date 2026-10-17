#!/usr/bin/env python3
"""Compile Apple catalogs once, then reuse their verified output in Windows builds."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

def digest(catalog):
    sha = hashlib.sha256()
    for path in sorted(catalog.rglob('*')):
        if path.is_file():
            data = path.read_bytes()
            if path.suffix == '.json':
                data = data.replace(b'\r\n', b'\n')
            sha.update(path.relative_to(catalog).as_posix().encode() + b'\0' + data + b'\0')
    return sha.hexdigest()

def verify(catalog, compiled):
    if not (compiled / 'manifest.json').is_file():
        raise SystemExit('Missing Apple-compiled assets. Compile the catalog once with Compile-iOS-Assets-Mac.command or the prepared icon-only GitHub workflow, then place its output in ios/CompiledAssets.')
    manifest = json.loads((compiled / 'manifest.json').read_text())
    if manifest.get('compiler') != 'Apple actool' or manifest.get('sourceSHA256') != digest(catalog):
        raise ValueError('Apple-compiled assets are missing or stale. Recompile the current catalog once with actool.')
    for name, expected in manifest['files'].items():
        if Path(name).name != name or not name.endswith(('.car', '.png', '.plist')):
            raise ValueError('Unexpected compiled asset file name')
        if hashlib.sha256((compiled / name).read_bytes()).hexdigest() != expected:
            raise ValueError('Compiled asset hash mismatch: ' + name)
    if 'Assets.car' not in manifest['files'] or 'partial-info.plist' not in manifest['files']:
        raise ValueError('Compiled catalog or icon metadata is missing')
    if not (compiled / 'Assets.car').read_bytes().startswith(b'BOMStore'):
        raise ValueError('Invalid compiled catalog header')
    info = plistlib.loads((compiled / 'partial-info.plist').read_bytes())
    if not info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {}).get('CFBundleIconName'):
        raise ValueError('Compiled catalog has no primary app icon')
    return manifest, info

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=['compile', 'verify', 'apply'])
parser.add_argument('catalog', type=Path)
parser.add_argument('compiled', type=Path)
parser.add_argument('input_ipa', type=Path, nargs='?')
parser.add_argument('output_ipa', type=Path, nargs='?')
args = parser.parse_args()
if args.mode == 'compile':
    if platform.system() != 'Darwin':
        raise SystemExit('Apple actool requires macOS. Signing and upload continue on Windows after this one-time compilation.')
    if args.compiled.exists() and any(args.compiled.iterdir()):
        raise SystemExit('Choose an empty output folder; existing compiled assets will not be deleted.')
    with tempfile.TemporaryDirectory(prefix='sprity-apple-assets-') as temporary:
        output = Path(temporary)
        subprocess.run(['xcrun', 'actool', '--compile', str(output), '--platform', 'iphoneos', '--minimum-deployment-target', '17.0', '--app-icon', 'AppIcon', '--target-device', 'iphone', '--target-device', 'ipad', '--output-partial-info-plist', str(output / 'partial-info.plist'), str(args.catalog.resolve())], check=True)
        # Validate with Apple's reader before publishing reusable output.
        subprocess.run(['xcrun', 'assetutil', '--info', str(output / 'Assets.car')], check=True, stdout=subprocess.DEVNULL)
        files = [p for p in output.iterdir() if p.is_file() and p.suffix in ('.car', '.png', '.plist')]
        manifest = {'compiler': 'Apple actool', 'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(), 'sourceSHA256': digest(args.catalog), 'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
        args.compiled.mkdir(parents=True, exist_ok=True)
        for file in files:
            shutil.copyfile(file, args.compiled / file.name)
        (args.compiled / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify(args.catalog, args.compiled)
    print('Apple catalog compiled and validated; reuse this folder on Windows.')
else:
    manifest, additions = verify(args.catalog, args.compiled)
    if args.mode == 'apply':
        if not args.input_ipa or not args.output_ipa or args.input_ipa.resolve() == args.output_ipa.resolve():
            raise ValueError('Use distinct input and output IPA paths')
        with zipfile.ZipFile(args.input_ipa) as source, zipfile.ZipFile(args.output_ipa, 'w', zipfile.ZIP_DEFLATED) as target:
            roots = [name[:-len('Info.plist')] for name in source.namelist() if name.count('/') == 2 and name.endswith('.app/Info.plist')]
            if len(roots) != 1:
                raise ValueError('Expected exactly one root app')
            root = roots[0]
            for entry in source.infolist():
                relative = entry.filename[len(root):] if entry.filename.startswith(root) else None
                if relative and '/' not in relative and (relative == 'Assets.car' or (relative.startswith('AppIcon') and relative.endswith('.png'))):
                    continue
                data = source.read(entry.filename)
                if entry.filename == root + 'Info.plist':
                    info = plistlib.loads(data)
                    icon_keys = {'CFBundleIcons', 'CFBundleIcons~ipad', 'CFBundleIconFile', 'CFBundleIconFiles', 'CFBundleIconName', 'UIPrerenderedIcon'}
                    info.update({key: value for key, value in additions.items() if key in icon_keys})
                    data = plistlib.dumps(info)
                target.writestr(entry, data)
            for name in manifest['files']:
                if name.endswith(('.car', '.png')):
                    entry = zipfile.ZipInfo(root + name)
                    entry.external_attr = 0o100644 << 16
                    target.writestr(entry, (args.compiled / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
        print('Applied Apple-compiled assets; this modified IPA must now be signed.')
    else:
        print('Compiled assets match the current source catalog and recorded hashes.')
