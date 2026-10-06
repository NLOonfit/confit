const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{chooseBlender:()=>ipcRenderer.invoke('choose-blender')});
