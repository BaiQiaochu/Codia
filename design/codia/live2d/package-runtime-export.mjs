// Package the real Cubism export together with the verified nine-parameter loop.
// Authoring sources and candidate exports are read-only inputs.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, 'export-candidate-v2');
const destination = path.join(root, 'export');
const desktop = path.resolve(root, '../../../desktop/src/assets/codia/live2d/model');
const model = JSON.parse(await readFile(path.join(source, 'Codia.model3.json'), 'utf8'));
const motionBytes = await readFile(path.join(root, 'preview/Codia.peek.motion3.json'));
const motion = JSON.parse(motionBytes);
if (motion.Meta?.CurveCount !== 9 || motion.Meta?.Duration !== 10 || motion.Meta?.Loop !== true) {
  throw new Error('Expected the verified nine-parameter, ten-second loop.');
}
const references = [model.FileReferences.Moc, ...model.FileReferences.Textures, model.FileReferences.DisplayInfo];
if (references.some(name => !name || name.includes('..') || path.isAbsolute(name))) throw new Error('Invalid local export reference.');
const hashes = {};
for (const relative of references) {
  const bytes = await readFile(path.join(source, relative));
  hashes[relative] = createHash('sha256').update(bytes).digest('hex');
  for (const target of [destination, desktop]) {
    const output = path.join(target, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }
}
model.FileReferences.Motions = { Idle: [{ File: 'Motions/Codia.peek.motion3.json', FadeInTime: 0, FadeOutTime: 0 }] };
for (const target of [destination, desktop]) {
  await mkdir(path.join(target, 'Motions'), { recursive: true });
  await writeFile(path.join(target, 'Motions/Codia.peek.motion3.json'), motionBytes);
  await writeFile(path.join(target, 'Codia.model3.json'), `${JSON.stringify(model, null, 2)}\n`);
}
const checkpoint = path.join(root, 'checkpoints/core-loop-webgl-20261006');
await mkdir(checkpoint, { recursive: true });
await copyFile(path.join(root, 'Codia-rig-repair.cmo3'), path.join(checkpoint, 'Codia-rig-repair.cmo3'));
await writeFile(path.join(destination, 'package.json'), `${JSON.stringify({
  character: 'Codia', source: '../Codia-rig-repair.cmo3', candidate: '../export-candidate-v2',
  binaryHashes: hashes, motion: { file: 'Motions/Codia.peek.motion3.json', parameters: 9, duration: 10, loop: true },
  scope: 'Body rise, independent hand reach/grip, head X/Y and iris X/Y. Original closed-fist artwork retained.',
  inactiveExtras: ['ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamHairSwing'],
}, null, 2)}\n`);
console.log(JSON.stringify({ destination, desktop, hashes, motionCurves: 9, sourceCheckpoint: checkpoint }, null, 2));
