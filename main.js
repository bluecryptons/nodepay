const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const log = require('loglevel');

dotenv.config();

const WEBSOCKET_URL = "wss://nw.nodepay.ai:4576/websocket";
const SERVER_HOSTNAME = "nw.nodepay.ai";
const RETRY_INTERVAL = 60000; // in milliseconds
const PING_INTERVAL = 10000; // in milliseconds
const NP_TOKEN = process.env.NP_TOKEN;

async function getUserId() {
  try {
    const response = await axios.get('https://api.nodepay.ai/api/network/device-networks?page=0&size=10&active=false', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NP_TOKEN}`,
      },
    });
    return response.data.data[0].user_id;
  } catch (error) {
    log.error('Error fetching user ID:', error);
    throw error;
  }
}

async function callApiInfo(token) {
  return {
    code: 0,
    data: {
      uid: await getUserId(),
    },
  };
}

async function connectSocketProxy(httpProxy, token, reconnectInterval = RETRY_INTERVAL, pingInterval = PING_INTERVAL) {
  const browserId = uuidv4();
  log.info(`Browser ID: ${browserId}`);

  let retries = 0;

  while (true) {
    try {
      log.info(`Connecting to WebSocket via proxy: ${httpProxy}`);
      const ws = new WebSocket(WEBSOCKET_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
        },
        rejectUnauthorized: false,
      });

      ws.on('open', () => {
        log.info('Connected to WebSocket');
        retries = 0;
      });

      ws.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.action === 'PONG') {
          await sendPong(ws, data.id);
          setTimeout(() => sendPing(ws, data.id), pingInterval);
        } else if (data.action === 'AUTH') {
          const apiResponse = await callApiInfo(token);
          if (apiResponse.code === 0 && apiResponse.data.uid) {
            const authInfo = {
              user_id: apiResponse.data.uid,
              browser_id: browserId,
              user_agent: 'Mozilla/5.0',
              timestamp: Math.floor(Date.now() / 1000),
              device_type: 'extension',
              version: 'extension_version',
              token: token,
              origin_action: 'AUTH',
            };
            await sendPing(ws, data.id, authInfo);
          } else {
            log.error('Failed to authenticate');
          }
        }
      });

      ws.on('close', (code, reason) => {
        log.warn(`Connection closed: ${code} - ${reason}`);
      });

      ws.on('error', (error) => {
        log.error(`WebSocket error: ${error}`);
      });

    } catch (error) {
      log.error(`Connection error: ${error}`);
      retries += 1;
      log.info(`Retrying in ${reconnectInterval / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, reconnectInterval));
    }
  }
}

async function sendPing(ws, guid, options = {}) {
  const payload = {
    id: guid,
    action: 'PING',
    ...options,
  };
  ws.send(JSON.stringify(payload));
}

async function sendPong(ws, guid) {
  const payload = {
    id: guid,
    origin_action: 'PONG',
  };
  ws.send(JSON.stringify(payload));
}

async function main() {
  try {
    const proxies = fs.readFileSync('proxy-list.txt', 'utf-8').split('\n').filter(Boolean);

    if (proxies.length === 0) {
      throw new Error('No proxies found in proxy-list.txt');
    }

    proxies.forEach((proxy) => {
      connectSocketProxy(proxy, NP_TOKEN).catch((error) => log.error(`Error with proxy ${proxy}:`, error));
    });

  } catch (error) {
    log.error('Error in main:', error);
  }
}

process.on('SIGINT', () => {
  log.info('Process terminated');
  process.exit(0);
});

main();
