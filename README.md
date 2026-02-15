# RS3 Quest Buddy GL Beta

A next-generation quest companion overlay for RuneScape 3 that runs through the custom Alt1GL-Launcher. The GL Beta version adds advanced real-time game UI reading via WebGL render interception, enabling immersive quest guidance features that were impossible in previous versions.

**Version:** 0.1.0
**Homepage:** https://techpure.dev/RS3QuestBuddyBeta

## Features

### GL Beta Exclusive Features

- **Real-time Game UI Reading** - WebGL render interception via native addon enables instant access to rendered game data
- **Compass Rose Overlay** - Visual direction indicators on the in-game compass pointing to quest objectives
- **Minimap Direction Arrows & Markers** - Quest waypoints and navigation hints rendered directly on the minimap
- **HUD Compass Overlay** - Dedicated compass element showing quest objective locations in real-time
- **Quest Step Text Overlay** - Current quest step displayed directly on screen for easy reference
- **Path Tube Overlay** - 3D pathfinding visualization showing the recommended route to objectives
- **Collision Overlay** - Visual representation of walkable and blocked tiles in the game world
- **Dialog Solver** - Automatic detection and tracking of in-game dialog options
- **Inventory Tracking** - Real-time item detection using tooltip learning and perceptual hashing (pHash)
- **Player Position Tracking** - Determines player location by analyzing the rendered 3D scene
- **Auto-advance Quest Steps** - Automatically progress quests based on dialog, location, or inventory conditions
- **Sprite Identification System** - CRC32 and pHash-based sprite matching for UI element detection

### Standard Features

- **Quest Step-by-Step Guides** - Comprehensive quest guides with rich text formatting
- **Quest Picker** - Browse all quests with search, filtering, and sorting capabilities
- **Multi-Quest Tracking** - Track multiple quests simultaneously with an integrated todo list
- **Customizable Themes** - Choose from multiple UI themes with personalized color schemes
- **Display Modes** - Toggle between compact and expanded interface layouts
- **Settings UI** - Full configuration for all GL overlay features including position editors
- **Persistent Storage** - All preferences and settings stored locally in browser storage

## Tech Stack

| Category | Technology |
|----------|-----------|
| **Frontend** | React 18, TypeScript |
| **UI Components** | Mantine UI v8 |
| **3D Graphics** | Three.js |
| **Math** | gl-matrix |
| **State Management** | Zustand |
| **Real-time Communication** | Socket.IO |
| **Game Integration** | Alt1 Toolkit API, Alt1 Launcher API |
| **GPU Interception** | patchrs (native addon) |
| **Build Tool** | Webpack 5 |
| **Styling** | SCSS, PostCSS |

## Installation

### Prerequisites

- Node.js 18 or later
- Alt1GL-Launcher (custom launcher with GL injection capabilities)
- RuneScape 3 client
- Git (for cloning the repository)

### Setup Steps

1. Clone the repository
   ```bash
   git clone <repository-url>
   cd RS3QuestBuddyBeta
   ```

2. Install dependencies
   ```bash
   npm install
   ```

3. Start the development server
   ```bash
   npm start
   ```
   The application will be available at `http://localhost:3001`

4. Add to Alt1GL-Launcher
   - Open Alt1GL-Launcher
   - Click "Add App"
   - Enter `http://localhost:3001` as the app URL
   - Start the app from the launcher

## Development

### Available Scripts

- `npm start` - Start development server with hot reload (port 3001)
- `npm run watch` - Watch mode for development without starting the server
- `npm run build` - Production build with webpack and automatic versioning

### Project Structure

```
src/
├── Entrance/              # App entry point, routing, settings context
├── pages/                 # Main page components
│   ├── Quest Details/     # Single quest guide and controls
│   ├── Quest Picker/      # Quest selection interface
│   └── Settings/          # User preferences and GL feature configuration
├── gl/                    # GL overlay components and rendering
│   ├── injection/         # WebGL interception layer
│   │   ├── DialogBoxReader/  # Dialog detection system
│   │   ├── overlays/      # TileOverlay, SpriteCache management
│   │   └── reflect2d/     # 2D rendering on 3D canvas
│   ├── shaders/           # GLSL shader programs
│   └── QuestStepOverlay/  # Step text rendering
├── integration/           # Game state and event integration
│   ├── engine/            # Quest completion engine
│   ├── inventory/         # Item tracking and detection
│   └── dialog/            # Dialog interaction bridge
├── state/                 # Zustand stores and type definitions
├── api/                   # API client and GL injection bridge
├── util/                  # Utilities (RichText parsing, pathfinding, etc.)
├── assets/                # Images, fonts, and stylesheets
└── Handlers/              # Event and data handlers
```

### Key Components

#### GL Injection System (`src/gl/injection/`)
The native addon (`patchrs`) intercepts WebGL render calls, allowing the application to:
- Read rendered sprite data from the game's UI atlases
- Extract tile and NPC position information from 3D scene rendering
- Monitor dialog box state and button positions

#### Quest Engine (`src/integration/engine/`)
Handles automatic quest progression through:
- Dialog option detection and clicking
- Location-based objective completion
- Inventory-based quest step advancement

#### Inventory Monitoring (`src/integration/`)
Real-time item tracking using:
- Tooltip learning system for item identification
- Perceptual hashing (pHash) for robust matching
- Cache invalidation for inventory changes

## Configuration

### User Settings

Settings are stored in browser localStorage and include:

- **UI Theme** - Default or brown theme with custom colors
- **Font Size** - Adjustable text rendering size
- **GL Overlays** - Enable/disable individual overlays
- **Overlay Positioning** - Custom positions for compass, minimap, HUD elements
- **Auto-advance** - Toggle quest auto-progression

Access settings in the Settings page after launching the application.

## Usage

### Basic Workflow

1. **Select a Quest** - Use the Quest Picker to browse and select a quest
2. **View Guide** - Read step-by-step instructions on the Quest Details page
3. **Use Overlays** - Enable GL overlays to visualize objectives and waypoints
4. **Track Progress** - The todo list tracks completed steps across multiple quests
5. **Auto-advance** - Enable auto-advance in settings for hands-free progression

### GL Overlay Usage

GL overlays require:
- Application loaded through Alt1GL-Launcher
- GL injection enabled in settings
- RuneScape 3 game window visible

Each overlay can be independently positioned using the overlay position editors in Settings.

## Troubleshooting

### GL Features Not Working

- Ensure Alt1GL-Launcher is being used, not a standard browser
- Check that GL injection is enabled in Settings
- Verify the native addon has been built (`build/Release/addon.node` exists)
- Restart the Alt1GL-Launcher if overlays appear blank

### Settings Not Persisting

- Check browser console for localStorage quota errors
- Clear browser cache and reload
- Verify browser localStorage is enabled

### Performance Issues

- Disable collision overlay if FPS drops significantly
- Reduce path tube resolution in settings
- Close other overlay-heavy apps running in Alt1GL-Launcher

## Build & Distribution

### Production Build

```bash
npm run build
```

This creates:
- Optimized webpack bundle in `dist/`
- Automatic version update in manifest
- Ready for deployment or Alt1 distribution

### Building the Native Addon

The native addon (`patchrs`) must be built separately:

```bash
# From the project root
npm run build:native
```

Requires Visual Studio Build Tools or equivalent C++ compiler.

## Browser Support

- Alt1GL-Launcher (Chromium-based)
- Modern Chromium/Chrome browsers
- WebGL 2.0 support required

Standard browser features (quest guides) work in any modern browser, but GL overlays require Alt1GL-Launcher with its GL injection capabilities.

## Known Limitations

- GL features only available when loaded through Alt1GL-Launcher
- Path visualization quality depends on game render resolution
- Inventory tracking limited to detectable item tooltips
- Dialog solver works best with standard RS3 UI settings

## Contributing

This is a beta release. Please report bugs and suggestions via the project homepage.

## License

See LICENSE file in repository root.

## Links

- **Homepage** - https://techpure.dev/RS3QuestBuddyBeta
- **Alt1 Toolkit** - https://alt1.app (reference - this project uses a custom launcher)
- **RuneScape 3** - https://www.runescape.com

## Acknowledgments

Built with the Alt1 Toolkit API as a library dependency, running through the custom Alt1GL-Launcher which provides GL injection capabilities. The standard Alt1 Toolkit cannot run this app - it requires the GL-Launcher specifically for WebGL interception via the patchrs native addon. Sprite identification and inventory tracking systems use advanced image processing techniques for reliable game state detection.
