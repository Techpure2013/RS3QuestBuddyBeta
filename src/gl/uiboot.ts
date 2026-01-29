const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron') as typeof import("electron");
const path = require('path') as typeof import("path");

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// app.allowRendererProcessReuse = false;
app.once('ready', () => {
	let entrypoint = process.argv[2] || "./controlpanel/index.html";
	let entrypath = path.resolve(app.getAppPath(), entrypoint);

	var wnd = new BrowserWindow({
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false,
			// nativeWindowOpen: true,
			nodeIntegrationInSubFrames: true
		}
	});
	wnd.loadFile(path.resolve(__dirname, entrypath));
	wnd.webContents.openDevTools({ mode: "right" });

	globalShortcut.register("Alt+Q", () => {
		wnd.webContents.executeJavaScript("stopRequested()");
	});
});

let puppetindex = 1;
const puppetwindows = new Map<number, InstanceType<typeof BrowserWindow>>()

ipcMain.handle("closewindow", async (e, id) => {
	let wnd = puppetwindows.get(id);
	wnd?.close();
	puppetwindows.delete(id);
})
ipcMain.handle("makewindow", async (e, url) => {
	let wnd = new BrowserWindow({
		webPreferences: {
			partition: `${Math.random()}`,
			nodeIntegration: false,
			contextIsolation: false,
			sandbox: true
		}
	});
	wnd.webContents.openDevTools({ mode: "right" });
	let id = puppetindex++;
	wnd.loadURL(url);
	await new Promise(done => wnd.webContents.once("dom-ready", () => done(undefined)));
	puppetwindows.set(id, wnd);
	return id;
});

ipcMain.handle("callwindow", async (e, id, code) => {
	let wnd = puppetwindows.get(id);
	if (!wnd) { throw new Error("puppet window does not exist"); }
	let res = await wnd.webContents.executeJavaScript(code, true);
	return res;
});