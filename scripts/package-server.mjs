import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const go = process.env.GO || 'go';
const dist = resolve('.local/server-dist');
mkdirSync(dist, { recursive: true });
const version = readFileSync('server/internal/stitch/config.go', 'utf8').match(/const Version = "([^"]+)"/)[1];
const checksums = [];
for (const [os, arch] of [['linux','amd64'], ['linux','arm64'], ['darwin','amd64'], ['darwin','arm64']]) {
  const name = `stitch-server-${version}-${os}-${arch}`;
  const directory = `${dist}/${name}`;
  // Dependency license files can be read-only; rebuild our generated staging
  // folder rather than trying to overwrite those files on the next package run.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  execFileSync(go, ['build','-trimpath','-ldflags=-s -w -buildid=','-o',`${directory}/stitch-server`,'./cmd/stitch-server'], { cwd: 'server', env: { ...process.env, CGO_ENABLED:'0', GOOS:os, GOARCH:arch }, stdio:'inherit' });
  cpSync('server/README.md', `${directory}/README.md`);
  cpSync('server/examples/stitch-server.json', `${directory}/stitch-server.example.json`);
  cpSync('server/examples', `${directory}/examples`, { recursive:true });
  cpSync('server/docs', `${directory}/docs`, { recursive:true });
  cpSync('server/licenses', `${directory}/licenses`, { recursive:true });
  cpSync('LICENSE', `${directory}/LICENSE`);
  const archive = `${name}.tar.gz`;
  execFileSync('tar', ['-czf', `${dist}/${archive}`, '-C', dist, name]);
  checksums.push(`${createHash('sha256').update(readFileSync(`${dist}/${archive}`)).digest('hex')}  ${archive}`);
}
writeFileSync(`${dist}/SHA256SUMS`, checksums.join('\n')+'\n');
console.log(`Packaged four native targets in ${dist}`);
