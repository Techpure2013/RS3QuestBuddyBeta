import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isElectron } from "../api/base";
import { initGlInjection, getInjectionState, retryGlInjection } from "../api/glInjection";

// Suppress known React warnings that don't affect functionality
const originalWarn = console.warn;
const originalError = console.error;

console.warn = (...args) => {
	if (typeof args[0] === "string") {
		// Suppress callback ref warning (React 18+ with Mantine/ReactQuill)
		if (args[0].includes("Unexpected return value from a callback ref")) {
			return;
		}
		// Suppress React Router v6 deprecation/future flag warnings
		if (args[0].includes("React Router") || args[0].includes("v7_")) {
			return;
		}
	}
	originalWarn.apply(console, args);
};

// Also suppress the callback ref error that comes through console.error
console.error = (...args) => {
	if (typeof args[0] === "string") {
		if (args[0].includes("Unexpected return value from a callback ref")) {
			return;
		}
	}
	originalError.apply(console, args);
};

// Initialize GL injection for Electron mode
if (isElectron) {
	console.log("Electron mode detected, initializing GL injection...");
	initGlInjection().then((success) => {
		if (success) {
			console.log("GL injection initialized successfully");
			const state = getInjectionState();
			console.log("Injection state:", state);
		} else {
			console.log("GL injection failed - RS client may not be running");
			console.log("You can retry with retryGlInjection() when the client is ready");
		}
	});

	// Expose retry function globally for debugging
	(window as unknown as { retryGlInjection: typeof retryGlInjection }).retryGlInjection = retryGlInjection;
}

// Mantine global + component styles
import "@mantine/core/styles/global.css";
import "@mantine/core/styles.css";
import "@mantine/core/styles/VisuallyHidden.css";
import "@mantine/core/styles/Flex.css";
import "@mantine/core/styles/Group.css";
import "@mantine/core/styles/Overlay.css";
import "@mantine/core/styles/Radio.css";
import "@mantine/core/styles/Accordion.css";
import "@mantine/core/styles/CloseButton.css";
import "@mantine/core/styles/Input.css";
import "@mantine/core/styles/UnstyledButton.css";
import "@mantine/core/styles/Button.css";
import "@mantine/core/styles/Loader.css";
import "@mantine/core/styles/Modal.css";
import "@mantine/core/styles/ModalBase.css";
import "@mantine/core/styles/Paper.css";
import "@mantine/core/styles/Popover.css";
import "@mantine/core/styles/ScrollArea.css";
import "@mantine/core/styles/ActionIcon.css";
import "@mantine/carousel/styles.css";

import "./../assets/css/index.css";
import "./../assets/rs3buddyicon.png";
import "./../assets/fonts/RS3Font.woff2";

import { MantineProvider } from "@mantine/core";
import { FontSizeProvider } from "./Entrance Components/FontContextProvider";
import { SocketProvider } from "./Entrance Components/socketContext";

const AltGuard = () => {
	const [override, setOverride] = useState(false);
	const hostname = window.location.hostname;

	useEffect(() => {
		// Skip Alt1 identification in Electron mode
		if (isElectron) return;

		if (window.alt1 && typeof alt1.identifyAppUrl === "function") {
			const configUrl =
				hostname === "localhost" || hostname === "127.0.0.1"
					? "./appconfig.local.json"
					: "./appconfig.prod.json";

			alt1.identifyAppUrl(configUrl);
		}
	}, [hostname]);

	// In Electron mode (GL injection), skip Alt1 check entirely
	if (isElectron) {
		return <App />;
	}

	if (window.alt1 || override) {
		return <App />;
	}

	// Fallback UI when Alt1 isn't found (web mode only)
	return (
		<div className="App">
			<h1>ALT1 not found</h1>
			<p>
				<a
					href={`alt1://addapp/${window.location.protocol}//${
						window.location.host
					}/${
						!window.location.host.includes("localhost")
							? "RS3QuestBuddy/"
							: ""
					}appconfig${
						!window.location.host.includes("localhost") ? ".prod" : ".local"
					}.json`}
				>
					<button className="Alt1button">Click here to add this to Alt1</button>
				</a>
			</p>

			<button className="Alt1button" onClick={() => setOverride(true)}>
				Continue to RS3 Quest Buddy Web (No Alt1)
			</button>
		</div>
	);
};

// Base HTML font size + render
document.querySelector("html")!.style.fontSize = "16px";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<SocketProvider>
		<MantineProvider defaultColorScheme="dark">
			<FontSizeProvider>
				<AltGuard />
			</FontSizeProvider>
		</MantineProvider>
	</SocketProvider>,
);
