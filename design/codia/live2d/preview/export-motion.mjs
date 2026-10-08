import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.resolve(sourceRoot, '../../../../.local-tools/live2d/preview-build');
await mkdir(outputRoot, { recursive: true });
const moduleFile = path.join(outputRoot, 'timeline.mjs');
await build({ entryPoints: [path.join(sourceRoot, 'timeline.ts')], outfile: moduleFile, bundle: true, platform: 'node', format: 'esm' });
const { sampleTimeline, coreParameterIds, duration } = await import(pathToFileURL(moduleFile).href);
const fps = 30;
const frames = duration * fps;
const curves = coreParameterIds.map(id => {
  const segments = [0, sampleTimeline(0)[id]];
  for (let frame = 1; frame <= frames; frame++) {
    const time = frame / fps;
    // Official motion3 segment type 0 is linear; 30 fps samples mirror the preview timeline.
    segments.push(0, Number(time.toFixed(6)), Number(sampleTimeline(time)[id].toFixed(6)));
  }
  return { Target: 'Parameter', Id: id, Segments: segments };
});
const motion = {
  Version: 3,
  Meta: { Duration: duration, Fps: fps, Loop: true, AreBeziersRestricted: true,
    CurveCount: curves.length, TotalSegmentCount: frames * curves.length,
    TotalPointCount: (frames + 1) * curves.length, UserDataCount: 0, TotalUserDataSize: 0 },
  Curves: curves, UserData: [],
};
const destination = path.join(sourceRoot, 'Codia.peek.motion3.json');
await writeFile(destination, JSON.stringify(motion));
console.log(`Nine-parameter Codia loop exported: ${destination}`);
