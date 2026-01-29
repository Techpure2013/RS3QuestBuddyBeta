declare const app: Electron.App, BrowserWindow: typeof Electron.CrossProcessExports.BrowserWindow, globalShortcut: Electron.GlobalShortcut, ipcMain: Electron.IpcMain;
declare const path: typeof import("path");
declare let puppetindex: number;
declare const puppetwindows: Map<number, Electron.CrossProcessExports.BrowserWindow>;
