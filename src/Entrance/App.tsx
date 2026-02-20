import { useEffect } from "react";
import { Routes, Route, BrowserRouter, Navigate, Outlet } from "react-router-dom";
import QuestCarousel from "./../pages/Quest Picker/QuestCarousel";
import QuestPage from "./../pages/Quest Details/questpage";
import { SettingsProvider } from "./Entrance Components/SettingsContext";
import { usePlayerStoreInit } from "./../state/usePlayerSelector";
import { ToastProvider } from "./../Components/Toast/useToast";
import { AppWithVersionCheck } from "./Entrance Components/AppWithVersionCheck";
import { deactivateStepOverlays, clearNpcHashCache, startPlayerTracking, stopPlayerTracking } from "./../gl";
import { isGlInjectionAvailable } from "../api/glInjection";

const isDev = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";

function App() {
	usePlayerStoreInit();

	// Start player position tracking immediately on app load
	// This allows early detection and caching of the player's VAO
	useEffect(() => {
		if (isGlInjectionAvailable()) {
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

	// Auto-start inventory tracking if setting was enabled
	// Delays to ensure GL pipeline is ready before creating the bridge
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;
		let cancelled = false;
		try {
			const saved = localStorage.getItem('appSettings');
			if (saved) {
				const parsed = JSON.parse(saved);
				if (parsed.inventoryTrackingEnabled) {
					const tryStart = (attempt: number) => {
						if (cancelled) return;
						import('./../integration').then(({ getOrCreateTooltipLearner }) => {
							getOrCreateTooltipLearner().then((learner) => {
								if (cancelled) return;
								learner.startPolling(1000);
								console.log(`[App] Inventory tracking auto-started (attempt ${attempt})`);
							}).catch((e) => {
								if (cancelled) return;
								if (attempt < 5) {
									console.log(`[App] Inventory tracking init attempt ${attempt} failed, retrying in ${attempt * 2}s...`);
									setTimeout(() => tryStart(attempt + 1), attempt * 2000);
								} else {
									console.warn('[App] Failed to start inventory tracking after 5 attempts:', e);
								}
							});
						});
					};
					// Wait 3 seconds for GL pipeline to be ready
					setTimeout(() => tryStart(1), 3000);
				}
			}
		} catch { /* ignore */ }
		return () => { cancelled = true; };
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
						<BrowserRouter basename={isDev ? "/" : "/RS3QuestBuddyBeta"}>
							<Routes>
								<Route path="/" element={<QuestCarousel />} />
								<Route path="/:questName" element={<QuestPage />} />
								<Route path="*" element={<Navigate to="/" />} />
							</Routes>
						</BrowserRouter>
					</SettingsProvider>
				</AppWithVersionCheck>
			</ToastProvider>
			<Outlet />
		</>
	);
}

export default App;
