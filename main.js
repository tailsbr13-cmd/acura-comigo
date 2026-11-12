const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
ipcMain.on('path', e => (e.returnValue = app.getPath('userData')));
if (!app.requestSingleInstanceLock()) app.quit();
let w;
ipcMain.on('do-close', () => { w.forceClose = true; w.close(); });
function create() {
  w = new BrowserWindow({
    width: 1200, height: 780, minWidth: 860, minHeight: 560,
    backgroundColor: '#0b1020', title: 'Acura Comigo',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  Menu.setApplicationMenu(null);
  w.on('close', e => { if (!w.forceClose) { e.preventDefault(); w.webContents.send('req-close'); } });
  w.loadFile('index.html');
  w.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
