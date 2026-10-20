// A dedicated Chromium host for the runtime eval. It never opens user profiles.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const root = process.argv[2];
if (!root || !path.basename(root).startsWith('codia-browser-eval-')) process.exit(2);
app.setPath('userData', root);
app.commandLine.appendSwitch('disable-background-networking');
let window;
app.on('window-all-closed', () => {});
app.whenReady().then(() => process.send?.({ type: 'ready' }));
process.on('disconnect', () => app.quit());
process.on('message', async message => {
  if (message.type === 'shutdown') { app.quit(); return; }
  if (message.type !== 'browser-cmd') return;
  const { cmd, id, params = {} } = message;
  try {
    await app.whenReady();
    let result = {};
    if (cmd === 'launch') {
      window = new BrowserWindow({ show: false, width: 800, height: 600,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url === 'about:blank' || /^http:\/\/127\.0\.0\.1:\d+\//.test(details.url);
        callback({ cancel: !allowed });
      });
      await window.loadURL('about:blank');
    } else if (cmd === 'navigate') {
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(params.url)) throw new Error('Fixture allows loopback only');
      await window.loadURL(params.url);
      result = { url: window.webContents.getURL(), title: window.webContents.getTitle(),
        snapshot: await window.webContents.executeJavaScript('document.body.innerText') };
    } else if (cmd === 'evaluate') {
      result = { value: JSON.stringify(await window.webContents.executeJavaScript(params.expression)) };
    } else if (cmd === 'snapshot') {
      result = { text: await window.webContents.executeJavaScript('document.body.innerText') };
    } else if (cmd === 'thumbnail') {
      result = { base64: (await window.webContents.capturePage()).toPNG().toString('base64') };
    } else if (cmd === 'close' || cmd === 'destroyView') {
      window?.destroy(); window = null;
    } else throw new Error(`Unsupported fixture browser action: ${cmd}`);
    process.send?.({ type: 'browser-result', id, result });
  } catch (error) { process.send?.({ type: 'browser-result', id, error: error.message }); }
});
