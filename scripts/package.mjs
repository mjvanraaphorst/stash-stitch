import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
mkdirSync('.local', { recursive: true });
// Fixed ZIP timestamps make the checksum reproducible on every build host.
execFileSync('python3', ['-c', `
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
from pathlib import Path
with ZipFile('.local/stash-stitch.zip','w',compression=ZIP_DEFLATED) as archive:
    for source in sorted(Path('plugin').iterdir()):
        if source.is_file():
            info=ZipInfo(source.name,(2026,11,17,0,0,0))
            info.compress_type=ZIP_DEFLATED
            info.external_attr=0o100644 << 16
            archive.writestr(info,source.read_bytes())
    info=ZipInfo('LICENSE',(2026,11,17,0,0,0))
    info.compress_type=ZIP_DEFLATED
    info.external_attr=0o100644 << 16
    archive.writestr(info,Path('LICENSE').read_bytes())
`]);
const hash = createHash('sha256').update(readFileSync('.local/stash-stitch.zip')).digest('hex');
const { version } = JSON.parse(readFileSync('package.json'));
writeFileSync('index.yml', `- id: stash-stitch\n  name: Stash Stitch\n  metadata:\n    description: Play scene groups as one chaptered video with a combined timeline and browser-side prebuffering.\n  version: ${version}\n  date: 2026-11-17 00:00:00\n  path: https://github.com/mjvanraaphorst/stash-stitch/releases/download/v${version}/stash-stitch.zip\n  sha256: ${hash}\n`);
console.log(`Packaged .local/stash-stitch.zip (${hash})`);
