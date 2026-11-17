const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const fs = require('fs'), path = require('path');
const ICON = path.join(__dirname, 'build', 'icon.ico');

app.setAppUserModelId('com.acuracomigo.app'); // agrupa corretamente na barra de tarefas do Windows
ipcMain.on('path', e => (e.returnValue = app.getPath('userData')));
if (!app.requestSingleInstanceLock()) app.quit();

let w;
ipcMain.on('do-close', () => { w.forceClose = true; w.close(); });

// Caixa "Salvar como" (exportação .acura / PDF)
ipcMain.handle('save-dialog', (e, opts) => dialog.showSaveDialog(w, opts));

// Relatório PDF: renderiza o HTML recebido numa janela oculta, sem scripts, e imprime em PDF
ipcMain.handle('make-pdf', async (e, { html, out }) => {
  const tmp = path.join(app.getPath('temp'), 'acura-relatorio-' + Date.now() + '.html');
  let win;
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, nodeIntegration: false, contextIsolation: true } });
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(out, pdf);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (win) win.destroy();
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

function create() {
  w = new BrowserWindow({
    width: 1200, height: 780, minWidth: 860, minHeight: 560,
    backgroundColor: '#0b1020', title: 'Acura Comigo', icon: ICON,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  Menu.setApplicationMenu(null);
  w.on('close', e => { if (!w.forceClose) { e.preventDefault(); w.webContents.send('req-close'); } });
  w.loadFile('index.html');
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } });
}
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
