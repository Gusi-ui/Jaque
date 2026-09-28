import { DurableObject } from 'cloudflare:workers';
import {
  PING,
  PONG,
  PRESETS,
  presetById,
  type ClientLobbyMsg,
  type ServerLobbyMsg
} from '@jaque/shared';
import { parse, randomId, send } from './util';

/** Lo que guarda cada socket del lobby: quién es y qué ritmo busca. */
interface Attachment {
  player: string;
  seek: string | null;
}

/** Una partida que no avisa de su final en este tiempo deja de contarse. */
const MAX_GAME_MS = 24 * 60 * 60_000;

/**
 * El lobby: una sola instancia (`idFromName('lobby')`). Empareja búsquedas del
 * mismo ritmo y difunde las estadísticas cuando cambian, sin intervalos, para
 * que pueda hibernar.
 */
export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    // Partidas en juego, según los avisos de cada GameRoom. Un conjunto de ids
    // en lugar de un número: los avisos repetidos no descuadran la cuenta.
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS playing (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL)'
    );
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    // La primera vez, el contador de partidas jugadas parte del historial de D1.
    // Si D1 falla, se reintenta al siguiente despertar; mientras, cuenta desde 0.
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.storage.sql.exec("SELECT 1 FROM counters WHERE k = 'played'").toArray().length) return;
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
        ctx.storage.sql.exec("INSERT OR IGNORE INTO counters (k, v) VALUES ('played', ?)", row?.n ?? 0);
      } catch (err) {
        console.error('No se pudo contar el historial', err);
      }
    });
  }

  // ─── RPC (GameRoom) ────────────────────────────────────────────────

  gameStarted(id: string) {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO playing (id, started_at) VALUES (?, ?)',
      id,
      Date.now()
    );
    this.broadcastStats();
  }

  /** `played` es false si la partida se anuló: no cuenta como jugada. */
  gameEnded(id: string, played = false) {
    this.ctx.storage.sql.exec('DELETE FROM playing WHERE id = ?', id);
    if (played) {
      this.ctx.storage.sql.exec(
        "INSERT INTO counters (k, v) VALUES ('played', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
      );
    }
    this.broadcastStats();
  }

  // ─── WebSockets ────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const player = new URL(request.url).searchParams.get('player') ?? '';
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ player, seek: null } satisfies Attachment);
    this.broadcastStats();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const msg = parse<ClientLobbyMsg>(message);
    if (!msg) return;
    if (msg.t === 'ping') return send(ws, PONG);
    if (msg.t === 'seek') return this.seek(ws, String(msg.tc));
    if (msg.t === 'cancel') {
      this.setSeek(ws, null);
      this.broadcastStats();
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.broadcastStats(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.broadcastStats(ws);
  }

  // ─── Emparejamiento ────────────────────────────────────────────────

  private async seek(ws: WebSocket, tcId: string) {
    const preset = presetById(tcId);
    if (!preset) return send(ws, { t: 'error', msg: 'Control de tiempo desconocido' } satisfies ServerLobbyMsg);
    const me = this.setSeek(ws, null);

    const rival = this.ctx.getWebSockets().find((s) => {
      const a = s.deserializeAttachment() as Attachment;
      return s !== ws && a.seek === tcId && a.player !== me.player;
    });
    if (!rival) {
      this.setSeek(ws, tcId);
      send(ws, { t: 'seeking', tc: tcId } satisfies ServerLobbyMsg);
      return this.broadcastStats();
    }

    // Se retira la búsqueda del rival antes de esperar a la partida, para que
    // ningún otro mensaje lo empareje entretanto.
    const them = this.setSeek(rival, null);
    const [white, black] = Math.random() < 0.5 ? [me.player, them.player] : [them.player, me.player];
    const id = randomId();
    let ok = false;
    try {
      ok = await this.env.GAME_ROOM.getByName(id).pair(
        { initial: preset.initial, increment: preset.increment },
        white,
        black
      );
    } catch (err) {
      console.error('No se pudo crear la partida', err);
    }
    if (!ok) {
      const error: ServerLobbyMsg = { t: 'error', msg: 'No se pudo crear la partida, inténtalo de nuevo' };
      send(ws, error);
      send(rival, error);
    } else {
      const start: ServerLobbyMsg = { t: 'start', id };
      send(ws, start);
      send(rival, start);
    }
    this.broadcastStats();
  }

  private setSeek(ws: WebSocket, seek: string | null): Attachment {
    const a = { ...(ws.deserializeAttachment() as Attachment), seek };
    ws.serializeAttachment(a);
    return a;
  }

  // ─── Estadísticas ──────────────────────────────────────────────────

  private stats(except?: WebSocket): ServerLobbyMsg {
    const players = new Set<string>();
    const seeks: Record<string, number> = Object.fromEntries(PRESETS.map((p) => [p.id, 0]));
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment;
      players.add(a.player);
      if (a.seek) seeks[a.seek] = (seeks[a.seek] ?? 0) + 1;
    }
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM playing WHERE started_at < ?', Date.now() - MAX_GAME_MS);
    const games = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM playing').one().n;
    const played =
      sql.exec<{ v: number }>("SELECT v FROM counters WHERE k = 'played'").toArray()[0]?.v ?? 0;
    return { t: 'stats', players: players.size, games, seeks, played };
  }

  /** Se llama solo cuando algo cambia: conexión, desconexión, búsqueda o partida. */
  private broadcastStats(except?: WebSocket) {
    const msg = JSON.stringify(this.stats(except));
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) send(ws, msg);
  }
}
