import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import ffmpeg from 'ffmpeg-static';
mkdirSync('.local/media', { recursive: true });
for (const [name, color, width, frequency, fast] of [['one', '0x183d32', 640, 440, true], ['two', '0x2d2951', 640, 660, false], ['three', '0x733d1c', 640, 880, true], ['mixed', '0x294854', 480, 550, true], ['long', '0x183d32', 640, 440, true]]) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x360:r=30`, '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`, '-t', name === 'long' ? '120' : '8', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', ...(fast ? ['-movflags', '+faststart'] : []), `.local/media/${name}.mp4`]);
}
console.log('Generated synthetic test clips (no personal media).');
