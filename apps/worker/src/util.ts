const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Id de partida: 8 caracteres alfanuméricos (encaja con GAME_ID_RE). */
export function randomId(len = 8) {
  let s = '';
  while (s.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len))) {
      // Descartar los bytes ≥ 248 (= 4 × 62) para que todas las letras sean equiprobables.
      if (b < 248 && s.length < len) s += ALPHABET[b % ALPHABET.length];
    }
  }
  return s;
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export function isWebSocketUpgrade(request: Request) {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

/** Envía por un socket sin fallar si ya se está cerrando. */
export function send(ws: WebSocket, msg: unknown) {
  try {
    ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  } catch {
    // El socket se cerró entretanto; el cliente se reconectará.
  }
}

export function parse<T>(message: string | ArrayBuffer): T | null {
  try {
    return JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
  } catch {
    return null;
  }
}
