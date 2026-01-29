import { useEffect } from "react";
import { Routes, Route, BrowserRouter, HashRouter, Navigate, Outlet } from "react-router-dom";
import QuestCarousel from "./../pages/Quest Picker/QuestCarousel";
import QuestPage from "./../pages/Quest Details/questpage";
import { SettingsProvider } from "./Entrance Components/SettingsContext";
import { usePlayerStoreInit } from "./../state/usePlayerSelector";
import { ToastProvider } from "./../Components/Toast/useToast";
import { AppWithVersionCheck } from "./Entrance Components/AppWithVersionCheck";
import { deactivateStepOverlays, clearNpcHashCache, startPlayerTracking, stopPlayerTracking } from "./../gl";

const isDev = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
const isElectron = window.location.protocol === "file:";

// Use HashRouter for Electron (file:// protocol), BrowserRouter otherwise
const Router = isElectron ? HashRouter : BrowserRouter;

function App() {
	usePlayerStoreInit();

	// Start player position tracking immediately on app load
	// This allows early detection and caching of the player's VAO
	useEffect(() => {
		if (isElectron) {
			// console.log("[App] Starting early player position tracking...");
			startPlayerTracking(
				(pos) => {
					// Just log position updates - the VAO detection happens internally
					// console.log(`[App] Player position: (${pos.location.lat.toFixed(1)}, ${pos.location.lng.toFixed(1)}) floor ${pos.floor}`);
				},
				2000 // Poll every 2 seconds for early detection (slower than quest mode)
			).then((started) => {
				if (started) {
					// console.log("[App] Early player tracking started successfully");
				}
			});
		}

		return () => {
			// Don't stop tracking on unmount - let quest pages take over
		};
	}, []);

	// Cleanup all GL overlays when the application exits
	useEffect(() => {
		const handleBeforeUnload = () => {
			stopPlayerTracking();
			deactivateStepOverlays();
			clearNpcHashCache();
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
			// Also cleanup on unmount
			handleBeforeUnload();
		};
	}, []);
	return (
		<>
			<ToastProvider>
				<AppWithVersionCheck>
					<SettingsProvider>
						<Router basename={isElectron ? undefined : (isDev ? "/" : "/RS3QuestBuddy")}>
							<Routes>
								<Route path="/" element={<QuestCarousel />} />
								<Route path="/:questName" element={<QuestPage />} />
								<Route path="*" element={<Navigate to="/" />} />
							</Routes>
						</Router>
					</SettingsProvider>
				</AppWithVersionCheck>
			</ToastProvider>
			<Outlet />
		</>
	);
}

export default App;
