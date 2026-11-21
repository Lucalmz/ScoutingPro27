import http from 'http';
import { WebSocketServer } from 'ws';
import mqttPacket from 'mqtt-packet';

/**
 * In-process MQTT 3.1.1 over WebSocket broker for deterministic E2E signaling tests.
 * Supports CONNECT/CONNACK, PINGREQ/PINGRESP, SUBSCRIBE/SUBACK (+ retained delivery),
 * UNSUBSCRIBE/UNSUBACK, PUBLISH (QoS 0/1 + retain storage & deletion), and DISCONNECT.
 */
export async function startLocalMqttBroker(host = '127.0.0.1', port = 0) {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('MQTT WebSocket endpoint is /mqtt');
  });

  const wss = new WebSocketServer({
    server,
    path: '/mqtt',
    handleProtocols: (protocols) => {
      const set = protocols instanceof Set ? protocols : new Set(protocols || []);
      return set.has('mqtt') ? 'mqtt' : Array.from(set)[0] || false;
    }
  });

  const clients = new Set();
  const clientById = new Map();
  const retainedMessages = new Map();

  wss.on('connection', (ws) => {
    const client = { ws, id: '', subs: new Set() };
    clients.add(client);

    const parser = mqttPacket.parser({ protocolVersion: 4 });
    const sendPacket = (pkt) => {
      if (ws.readyState === 1) {
        ws.send(mqttPacket.generate(pkt));
      }
    };

    parser.on('error', () => {
      try {
        ws.close();
      } catch {}
    });

    parser.on('packet', (pkt) => {
      switch (pkt.cmd) {
        case 'connect': {
          client.id = pkt.clientId || `anon-${Math.random().toString(36).slice(2, 8)}`;
          const existing = clientById.get(client.id);
          if (existing && existing !== client) {
            clients.delete(existing);
            try {
              existing.ws.close();
            } catch {}
          }
          clientById.set(client.id, client);
          sendPacket({ cmd: 'connack', returnCode: 0, sessionPresent: false });
          break;
        }
        case 'pingreq': {
          sendPacket({ cmd: 'pingresp' });
          break;
        }
        case 'subscribe': {
          const subs = Array.isArray(pkt.subscriptions) ? pkt.subscriptions : [];
          for (const s of subs) {
            client.subs.add(s.topic);
          }
          sendPacket({
            cmd: 'suback',
            messageId: pkt.messageId,
            granted: subs.map((s) => Math.min(s.qos || 0, 1))
          });
          for (const s of subs) {
            if (retainedMessages.has(s.topic)) {
              sendPacket({
                cmd: 'publish',
                qos: 0,
                dup: false,
                retain: true,
                topic: s.topic,
                payload: retainedMessages.get(s.topic)
              });
            }
          }
          break;
        }
        case 'unsubscribe': {
          const unsubs = Array.isArray(pkt.unsubscriptions) ? pkt.unsubscriptions : [];
          for (const t of unsubs) {
            client.subs.delete(t);
          }
          sendPacket({ cmd: 'unsuback', messageId: pkt.messageId });
          break;
        }
        case 'publish': {
          const payloadBuf = Buffer.isBuffer(pkt.payload)
            ? pkt.payload
            : Buffer.from(pkt.payload || '');
          if (pkt.retain) {
            if (payloadBuf.length === 0) {
              retainedMessages.delete(pkt.topic);
            } else {
              retainedMessages.set(pkt.topic, Buffer.from(payloadBuf));
            }
          }
          if (pkt.qos === 1 && pkt.messageId !== undefined) {
            sendPacket({ cmd: 'puback', messageId: pkt.messageId });
          }
          const outFrame = mqttPacket.generate({
            cmd: 'publish',
            qos: 0,
            dup: false,
            retain: false,
            topic: pkt.topic,
            payload: payloadBuf
          });
          for (const peer of clients) {
            if (peer.ws.readyState === 1 && peer.subs.has(pkt.topic)) {
              peer.ws.send(outFrame);
            }
          }
          break;
        }
        case 'disconnect': {
          try {
            ws.close();
          } catch {}
          break;
        }
        default:
          break;
      }
    });

    ws.on('message', (data) => {
      try {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        parser.parse(buf);
      } catch {
        try {
          ws.close();
        } catch {}
      }
    });

    const cleanup = () => {
      clients.delete(client);
      if (client.id && clientById.get(client.id) === client) {
        clientById.delete(client.id);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `ws://${host}:${actualPort}/mqtt`;

  const close = async () => {
    for (const c of Array.from(clients)) {
      try {
        c.ws.terminate();
      } catch {}
    }
    clients.clear();
    clientById.clear();
    retainedMessages.clear();
    await new Promise((resolve) => wss.close(() => resolve())).catch(() => {});
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
  };

  return { url, port: actualPort, close };
}
