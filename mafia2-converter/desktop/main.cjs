const {app,BrowserWindow,dialog,ipcMain} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {startServer} = require('./server.cjs');
let server, window, blender = 'blender';
const settings = () => path.join(app.getPath('userData'),'settings.json');

app.whenReady().then(async () => {
  try { const config=JSON.parse(await fs.readFile(settings(),'utf8')); if(typeof config.blender==='string') blender=config.blender; } catch {}
  const backend=await startServer(path.resolve(__dirname,'..'),()=>blender);
  server=backend.server;
  ipcMain.handle('choose-blender',async () => {
    const result=await dialog.showOpenDialog(window,{title:'Выберите Blender',properties:['openFile'],filters:process.platform==='win32'?[{name:'Blender',extensions:['exe']}]:[]});
    if(result.canceled)return null;
    blender=result.filePaths[0];
    await fs.writeFile(settings(),JSON.stringify({blender}));
    return path.basename(blender);
  });
  window=new BrowserWindow({width:1280,height:850,minWidth:800,minHeight:600,title:'Мафия 2 · Конвертер моделей',backgroundColor:'#15191e',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith(backend.url+'/'))event.preventDefault();});
  await window.loadURL(backend.url);
}).catch(err=>{dialog.showErrorBox('Ошибка запуска',err.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>server?.close());
