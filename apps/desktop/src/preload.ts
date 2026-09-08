import { contextBridge } from 'electron';
// The renderer uses same-origin HTTP with an HttpOnly session cookie. No keys or privileged IPC are exposed.
contextBridge.exposeInMainWorld('desktop',{platform:process.platform,version:'0.1.0'});
