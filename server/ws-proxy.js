const net = require('net');
const { WebSocketServer } = require('ws');
const config = require('./config');

// Bridges a browser WebSocket to the raw TCP RFB stream of the VNC server.
// This is only used when WS_URL is unset; when you already run websocketify
// in front of VNC, set WS_URL and the browser connects to that instead.
function createVncWss() {
  const wss = new WebSocketServer({
    noServer: true,
    // Accept the 'binary' subprotocol that noVNC requests
    handleProtocols(protocols) {
      if (protocols.has('binary')) return 'binary';
      return false;
    },
  });

  wss.on('connection', (ws) => {
    const target = net.createConnection(config.VNC_PORT, config.VNC_HOST, () => {
      target.setNoDelay(true);
      console.log(`WS proxy: connected to VNC backend ${config.VNC_HOST}:${config.VNC_PORT}`);
    });

    // Keepalive: ping every 30s to prevent idle disconnects
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      if (ws.readyState === ws.OPEN) ws.ping();
    }, 30000);

    target.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data, { binary: true });
      }
    });

    target.on('end', () => {
      ws.close();
    });

    target.on('error', (err) => {
      console.error('VNC connection error:', err.message);
      ws.close();
    });

    ws.on('message', (data) => {
      if (target.writable) {
        target.write(Buffer.from(data));
      }
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      target.destroy();
    });

    ws.on('error', (err) => {
      clearInterval(pingInterval);
      console.error('WebSocket error:', err.message);
      target.destroy();
    });
  });

  return wss;
}

module.exports = { createVncWss };