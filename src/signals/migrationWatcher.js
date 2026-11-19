import WebSocket from 'ws';
import { now, pruneSeen } from '../utils.js';
import { graduated } from './graduated.js';
import { trending, storeSignalEvent } from './trending.js';

/**
 * PumpPortal's public migration feed. Used when no signal server is configured:
 * a bonding-curve migration to PumpSwap is the same event the server would call
 * "graduated", and it arrives as clean JSON instead of base64 program logs.
 *
 * The payload is deliberately thin — { signature, mint, txType: 'migrate', pool } —
 * so the candidate builder enriches the token itself.
 */
const WS_URL = process.env.PUMPPORTAL_WS_URL || 'wss://pumpportal.fun/api/data';
// Jupiter's asset index lags a fresh migration by tens of seconds, so the mint
// usually has no mcap at migration time. One delayed re-check is what turns a
// filtered "market cap null" into a real candidate.
const RECHECK_MS = Number(process.env.MIGRATION_RECHECK_MS || 90_000);
const seenMigrations = new Map();
let candidateHandler = null;
let socket = null;

export function setMigrationHandler(fn) {
  candidateHandler = fn;
}

export function migrationCount() {
  return seenMigrations.size;
}

async function dispatch(payload, label) {
  if (!candidateHandler) return;
  try {
    await candidateHandler(payload);
  } catch (error) {
    console.log(`[migration] ${label} dispatch failed: ${error.message}`);
  }
}

async function handleMigration(message) {
  const mint = message?.mint;
  if (!mint) return;
  pruneSeen(seenMigrations, 10 * 60_000);
  if (seenMigrations.has(mint)) return;
  seenMigrations.set(mint, now());

  const coin = {
    coinMint: mint,
    pool: message.pool || null,
    signature: message.signature || null,
    graduationDate: now(),
    seenAt: now(),
    source: 'pumpportal_ws',
  };
  graduated.set(mint, coin);
  storeSignalEvent(mint, 'graduated', 'pumpportal_ws', {
    signature: message.signature || null,
    pool: message.pool || null,
  });
  console.log(`[migration] ${mint.slice(0, 8)}... migrated (${message.pool || 'unknown pool'})`);

  const payload = {
    mint,
    fee: null,
    signature: message.signature || null,
    graduatedCoin: coin,
    trendingToken: trending.get(mint) || null,
    route: 'graduated',
  };
  await dispatch(payload, 'immediate');

  setTimeout(() => {
    dispatch({ ...payload, route: 'graduated_recheck', trendingToken: trending.get(mint) || null }, 'recheck')
      .catch(() => {});
  }, RECHECK_MS).unref();
}

function connect() {
  socket = new WebSocket(WS_URL);
  let pingTimer = null;

  socket.on('open', () => {
    console.log('[migration] subscribed to migration feed');
    socket.send(JSON.stringify({ method: 'subscribeMigration' }));
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.txType !== 'migrate') return;
    handleMigration(message).catch(error => console.log(`[migration] handle failed: ${error.message}`));
  });

  socket.on('close', () => {
    clearInterval(pingTimer);
    console.log('[migration] closed, reconnecting in 5s');
    setTimeout(connect, 5_000);
  });

  socket.on('error', (error) => {
    console.log(`[migration] ${error.message}`);
  });
}

export function startMigrationWatcher() {
  connect();
}
