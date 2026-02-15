/**
 * Overlay Mouse Client
 *
 * Minimal IPC client that connects to the overlay DLL's named pipe
 * to receive mouse position updates. The overlay DLL sends the current
 * mouse position (from WM_MOUSEMOVE) each frame via MousePositionUpdate messages.
 *
 * Coordinates are in client (window) space: top-left origin, Y-down.
 */

// Dynamic require to avoid webpack trying to bundle Node.js 'net' module
// eslint-disable-next-line @typescript-eslint/no-var-requires
let net: any = null;
try {
  const netModule = 'n' + 'et';
  net = require(netModule);
} catch {
  // Not available in browser context - connect() will return false
}

// Message type - must match overlay/src/ipc.h
const MSG_MOUSE_POSITION_UPDATE = 0x07;

export class OverlayMouseClient {
  private socket: any = null;  // net.Socket | null
  private connected = false;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private lastX = 0;
  private lastY = 0;
  private valid = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private targetPid: number = 0;

  /**
   * Connect to the overlay's named pipe for the given RS3 client PID.
   */
  async connect(pid: number): Promise<boolean> {
    if (!net) {
      console.log('[OverlayMouse] net module not available (browser context)');
      return false;
    }

    this.targetPid = pid;
    const pipePath = `\\\\.\\pipe\\alt1gl-overlay-${pid}`;

    return new Promise((resolve) => {
      let resolved = false;
      const resolveOnce = (result: boolean) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      console.log(`[OverlayMouse] Connecting to ${pipePath}...`);

      this.socket = net!.createConnection(pipePath, () => {
        console.log('[OverlayMouse] Connected to overlay pipe');
        this.connected = true;
        resolveOnce(true);
      });

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('error', (err: any) => {
        if (!resolved) {
          console.log(`[OverlayMouse] Connection error: ${err.code} - ${err.message}`);
        }
        this.connected = false;
        this.valid = false;
        resolveOnce(false);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.valid = false;
        this.scheduleReconnect();
      });

      // Timeout after 3 seconds
      setTimeout(() => {
        if (!resolved) {
          console.log('[OverlayMouse] Connection timeout');
          this.socket?.destroy();
          resolveOnce(false);
        }
      }, 3000);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.targetPid) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected && this.targetPid) {
        this.connect(this.targetPid);
      }
    }, 2000);
  }

  private handleData(data: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);

    while (this.recvBuffer.length >= 3) {
      const type = this.recvBuffer.readUInt8(0);
      const payloadSize = this.recvBuffer.readUInt16LE(1);

      // Handle extended length marker (0xFFFF = 32-bit length follows)
      if (payloadSize === 0xFFFF) {
        if (this.recvBuffer.length < 7) break;
        const extSize = this.recvBuffer.readUInt32LE(3);
        if (this.recvBuffer.length < 7 + extSize) break;
        // Skip large messages - we only care about MousePositionUpdate
        this.recvBuffer = this.recvBuffer.subarray(7 + extSize);
        continue;
      }

      if (this.recvBuffer.length < 3 + payloadSize) break;

      const payload = this.recvBuffer.subarray(3, 3 + payloadSize);
      this.recvBuffer = this.recvBuffer.subarray(3 + payloadSize);

      // Only process MousePositionUpdate messages, skip everything else
      if (type === MSG_MOUSE_POSITION_UPDATE && payload.length >= 5) {
        this.lastX = payload.readInt16LE(0);
        this.lastY = payload.readInt16LE(2);
        this.valid = payload.readUInt8(4) !== 0;
      }
    }
  }

  /**
   * Get current mouse position in client coordinates (top-left origin, Y-down).
   * Returns null if position is unknown or not connected.
   */
  getMousePosition(): { x: number; y: number } | null {
    if (!this.valid || !this.connected) return null;
    return { x: this.lastX, y: this.lastY };
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.targetPid = 0;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.valid = false;
  }
}
