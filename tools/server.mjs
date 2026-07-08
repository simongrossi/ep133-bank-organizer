import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));

// Liste de ports à essayer. Le premier est PORT (env) ou 8080 ; les suivants
// servent de repli automatique si un port est déjà pris ou refusé par le
// système (EADDRINUSE / EACCES, fréquent sous Windows avec Hyper-V/WSL/agents).
const preferred = Number(process.env.PORT || 8080);
const candidates = [preferred, 8080, 3000, 5173, 8000, 8090, 4173, 0]
  .filter((value, index, all) => Number.isFinite(value) && all.indexOf(value) === index);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav'
};

function createApp() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const decodedPath = decodeURIComponent(url.pathname);
      let filePath = normalize(join(root, decodedPath));
      if (!filePath.startsWith(root)) throw new Error('Forbidden');
      const info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) filePath = join(filePath, 'index.html');
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Fichier introuvable');
    }
  });
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* ouverture best-effort : sans navigateur, l'URL reste affichée dans la console */
  }
}

function listen(portList) {
  const [current, ...rest] = portList;
  const server = createApp();

  server.once('error', error => {
    if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && rest.length) {
      console.warn(`Port ${current} indisponible (${error.code}). Tentative sur ${rest[0]}…`);
      listen(rest);
    } else {
      console.error(`Impossible de démarrer le serveur : ${error.code || error.message}`);
      process.exit(1);
    }
  });

  server.listen(current, '127.0.0.1', () => {
    const actualPort = server.address().port;
    const url = `http://localhost:${actualPort}`;
    console.log(`EP Bank Organizer est disponible sur ${url}`);
    console.log('Arrêt : Ctrl+C');
    openBrowser(url);
  });
}

listen(candidates);
