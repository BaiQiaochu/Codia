import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const filePattern = /^codia-\d{8}T\d{9}Z-[a-f0-9-]{36}\.(png|webm|json)$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        chunks.length = 0;
        reject(fail(413, 'Evidence exceeds the local size limit.'));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    request.on('aborted', () => reject(fail(400, 'Incomplete evidence upload.')));
    request.on('error', reject);
  });
}

/** A loopback-only preview route, not a production application API. */
export async function handleEvidence(request, response, { pathname, origin, directory, modelFile }) {
  if (pathname !== '/evidence' && !pathname.startsWith('/evidence/')) return false;
  try {
    if (request.headers.host !== new URL(origin).host
      || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Local preview origin required.');
    if (request.method === 'GET' && pathname.startsWith('/evidence/')) {
      const filename = pathname.slice('/evidence/'.length);
      if (!filePattern.test(filename)) throw fail(404, 'Evidence not found.');
      const contents = await readFile(path.join(directory, filename));
      const extension = path.extname(filename);
      response.setHeader('Content-Type', extension === '.png' ? 'image/png' : extension === '.webm' ? 'video/webm' : 'application/json');
      response.setHeader('Content-Disposition', `${request.headers['sec-fetch-dest'] === 'video' ? 'inline' : 'attachment'}; filename="${filename}"`);
      response.setHeader('Accept-Ranges', 'bytes');
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, contents.length - Number(match[2])) : NaN;
        const end = match?.[1] && match[2] ? Math.min(contents.length - 1, Number(match[2])) : contents.length - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= contents.length) {
          response.setHeader('Content-Range', `bytes */${contents.length}`);
          response.writeHead(416).end();
          return true;
        }
        response.setHeader('Content-Range', `bytes ${start}-${end}/${contents.length}`);
        response.setHeader('Content-Length', end - start + 1);
        response.writeHead(206).end(contents.subarray(start, end + 1));
      } else {
        response.setHeader('Content-Length', contents.length);
        response.end(contents);
      }
      return true;
    }
    if (request.method !== 'POST' || pathname !== '/evidence') throw fail(405, 'Use POST /evidence or GET /evidence/<filename>.');
    const mimeType = String(request.headers['content-type'] ?? '').toLowerCase().replace(/\s/g, '');
    const extension = mimeType === 'image/png' ? 'png' : /^video\/webm(?:;codecs=(?:vp8|vp9))?$/.test(mimeType) ? 'webm' : null;
    if (!extension) throw fail(415, 'Only canvas PNG and WebM evidence is accepted.');
    const limit = (extension === 'png' ? 32 : 64) * 1024 * 1024;
    const declaredSize = Number(request.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > limit) throw fail(413, 'Evidence exceeds the local size limit.');
    let capture;
    try { capture = JSON.parse(String(request.headers['x-codia-evidence'] ?? '')); }
    catch { throw fail(400, 'Capture metadata is required.'); }
    if (capture?.source !== 'preview-canvas' || capture.format !== extension || capture.completed !== true
      || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)
      || capture.width < 1 || capture.width > 8192 || capture.height < 1 || capture.height > 8192) throw fail(400, 'Invalid canvas evidence metadata.');
    if (extension === 'webm' && (capture.cycles !== 2 || capture.startTime !== 0 || capture.timelineSeconds !== 20
      || !Number.isFinite(capture.elapsedSeconds) || capture.elapsedSeconds < 20 || capture.elapsedSeconds > 60)) throw fail(400, 'Only completed two-cycle recordings can be saved.');
    const body = await readBody(request, limit);
    const signature = extension === 'png' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    if (!body.subarray(0, signature.length).equals(signature)) throw fail(415, 'Evidence does not match its declared format.');
    const createdAt = new Date().toISOString();
    const stem = `codia-${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}`;
    const filename = `${stem}.${extension}`;
    const localPath = path.join(directory, filename);
    const metadataPath = path.join(directory, `${stem}.json`);
    const metadata = {
      schemaVersion: 1, createdAt, source: 'local-preview-canvas', modelFile,
      filename, localPath, mimeType, bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      capture: { format: extension, completed: true, width: capture.width, height: capture.height,
        ...(extension === 'webm' ? { cycles: 2, startTime: 0, timelineSeconds: 20, elapsedSeconds: capture.elapsedSeconds }
          : { time: Number.isFinite(capture.time) ? capture.time : null }) },
      visualAccepted: false,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(localPath, body, { flag: 'wx' });
    try { await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) { await unlink(localPath); throw error; }
    response.setHeader('Content-Type', 'application/json');
    response.writeHead(201).end(JSON.stringify({ saved: true, ...metadata, metadataPath,
      downloadUrl: `/evidence/${filename}`, metadataUrl: `/evidence/${stem}.json` }));
  } catch (error) {
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.writeHead(error.status ?? (error.code === 'ENOENT' ? 404 : 500))
      .end(JSON.stringify({ saved: false, error: error.status ? error.message : 'Local evidence could not be saved or read.' }));
  }
  return true;
}
