import { IRacingSDK } from 'irsdk-node';
import { Server } from 'socket.io';
import { io as clientIo } from 'socket.io-client';
import http from 'http';
import readline from 'readline-sync';

const LOCAL_PORT = 3001;
const httpServer = http.createServer();
const localIo = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const irsdk = new IRacingSDK();
irsdk.startSDK();

console.log('🚀 iRacing Strategy Bridge Started');

// --- Helper for CLI Args ---
const getArg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : null;
};

// --- Session Setup ---
let mode: number;
let relayUrl: string | null = null;
let sessionId: string | null = null;
let pin: string | null = null;

const argMode = getArg('--mode');
if (argMode !== null) {
  mode = parseInt(argMode);
  relayUrl = getArg('--relay');
  sessionId = getArg('--session');
  pin = getArg('--pin');
  console.log('📝 Loaded configuration from CLI arguments');
} else {
  mode = readline.keyInSelect(['Local Only', 'Cloud Relay', 'Both'], 'Select Broadcast Mode:');
  if (mode === -1) process.exit();
}

let remoteSocket: any = null;

if ((mode === 1 || mode === 2)) {
  if (!relayUrl) relayUrl = readline.question('Enter Relay Server URL: ') || 'http://localhost:3000';
  if (!sessionId) sessionId = readline.question('Enter custom Session ID: ');
  if (!pin) pin = readline.question('Enter Session PIN: ', { hideEchoBack: true });

  console.log(`📡 Connecting to Relay: ${relayUrl}`);
  remoteSocket = clientIo(relayUrl as string);
  
  remoteSocket.on('connect', () => {
    console.log('✅ Connected to Cloud Relay');
    remoteSocket.emit('host-session', { sessionId, pin });
  });

  remoteSocket.on('session-hosted', (data: any) => {
    console.log(`✅ Session hosted successfully: ${data.sessionId}`);
  });

  remoteSocket.on('error', (err: string) => {
    console.error('❌ Relay Error:', err);
  });
}

if (mode === 0 || mode === 2) {
  httpServer.listen(LOCAL_PORT);
  console.log(`🏠 Local server listening on port ${LOCAL_PORT}`);
}

// --- Telemetry Loop ---
let lastFuel: number = -1;
let fuelHistory: number[] = [];
let currentLap: number = -1;
let stintStartTime: number = Date.now();

const updateLoop = () => {
  if (irsdk.waitForData(100)) {
    const tele: any = {
      fuelLevel: Number(irsdk.getTelemetryVariable('FuelLevel')?.value || 0),
      fuelPct: Number(irsdk.getTelemetryVariable('FuelLevelPct')?.value || 0),
      lastLapTime: Number(irsdk.getTelemetryVariable('LapLastLapTime')?.value || 0),
      bestLapTime: Number(irsdk.getTelemetryVariable('LapBestLapTime')?.value || 0),
      lap: Number(irsdk.getTelemetryVariable('Lap')?.value || 0),
      sessionTimeRemain: Number(irsdk.getTelemetryVariable('SessionTimeRemain')?.value || 0),
      airTemp: Number(irsdk.getTelemetryVariable('AirTemp')?.value || 0),
      trackTemp: Number(irsdk.getTelemetryVariable('TrackTemp')?.value || 0),
    };

    const sessionData: any = irsdk.getSessionData();
    const trackName: string = sessionData?.WeekendInfo?.TrackDisplayName || 'Unknown';

    if (tele.lap !== currentLap) {
      if (currentLap !== -1 && lastFuel !== -1) {
        const consumed = Number(lastFuel) - Number(tele.fuelLevel);
        if (consumed > 0 && consumed < 20) {
          fuelHistory.push(consumed);
          if (fuelHistory.length > 10) fuelHistory.shift();
        }
      }
      currentLap = Number(tele.lap);
      lastFuel = Number(tele.fuelLevel);
    }

    const avgFuel = fuelHistory.length > 0 
      ? fuelHistory.reduce((a: number, b: number) => a + b, 0) / fuelHistory.length 
      : 0;

    const data = {
      ...tele,
      trackName,
      avgFuelPerLap: avgFuel,
      lapsOnTank: avgFuel > 0 ? (tele.fuelLevel / avgFuel) : 0,
       stintStartTime: stintStartTime
    };

    if (mode === 0 || mode === 2) localIo.emit('telemetry', data);
    if ((mode === 1 || mode === 2) && remoteSocket?.connected) {
      remoteSocket.emit('relay-telemetry', { sessionId, data });
    }
  }
  setTimeout(updateLoop, 500);
};

updateLoop();

process.on('SIGINT', () => {
  irsdk.stopSDK();
  process.exit();
});
