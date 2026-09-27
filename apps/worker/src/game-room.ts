import { DurableObject } from 'cloudflare:workers';
import { Game, type GameData } from '@jaque/engine';
import {
  PING,
  PONG,
  isOver,
  type ClientGameMsg,
  type Color,
  type GameStatus,
  type GameView,
  type ServerGameMsg,
  type TimeControl
} from '@jaque/shared';
import { parse, randomId, send } from './util';

/** Lo que guarda cada socket (sobrevive a la hibernación). */
interface Attachment {
  player: string;
  color: Color | null;
}

/** Partidas terminadas: se borran 2 h después si no queda nadie conectado. */
const KEEP_FINISHED_MS = 2 * 60 * 60_000;
/** Desafíos que nadie acepta: se borran tras 3 h sin actividad. */
const KEEP_WAITING_MS = 3 * 60 * 60_000;

const GAME_KEY = 'game';
/** true cuando la partida terminada ya está en D1. */
const ARCHIVED_KEY = 'archived';

/**
 * Una partida (un Durable Object por id). Usa la API de hibernación de
 * WebSockets: la memoria puede perderse en cualquier momento, así que el estado
 * se guarda tras cada cambio y se reconstruye al despertar. Los relojes van con
 * la Alarms API, nunca con setTimeout.
 */
export class GameRoom extends DurableObject<Env> {
  private game: Game | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // El keepalive del cliente se contesta sin despertar al objeto.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    ctx.blockConcurrencyWhile(async () => {
      const data = await ctx.storage.get<GameData>(GAME_KEY);
      this.game = data ? Game.fromJSON(data) : null;
    });
  }

  // ─── RPC (Worker y Lobby) ──────────────────────────────────────────

  /** Partida con un amigo: el creador se sienta con el color elegido. false si el id ya existe. */
  async init(tc: TimeControl, player: string, color: Color): Promise<boolean> {
    if (this.game) return false;
    const now = Date.now();
    this.game = new Game(this.ctx.id.name ?? '', tc, now);
    this.game.join(player, color, now);
    await this.commit('waiting');
    return true;
  }

  /** Partida con los dos jugadores ya sentados: empieza al instante. false si el id ya existe. */
  async pair(tc: TimeControl, white: string, black: string): Promise<boolean> {
    if (this.game) return false;
    const now = Date.now();
    this.game = new Game(this.ctx.id.name ?? '', tc, now);
    this.game.join(white, 'white', now);
    this.game.join(black, 'black', now);
    await this.commit('waiting');
    return true;
  }

  view(): GameView | null {
    return this.game?.view(Date.now(), this.online()) ?? null;
  }

  // ─── WebSockets ────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const game = this.game;
    if (!game) return new Response('Partida no encontrada', { status: 404 });
    const player = new URL(request.url).searchParams.get('player') ?? '';

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const color = game.colorOf(player);
    server.serializeAttachment({ player, color } satisfies Attachment);
    send(server, { t: 'hello', you: color } satisfies ServerGameMsg);

    if (game.status === 'waiting') {
      // Visitar un desafío cuenta como actividad: retrasa su limpieza.
      game.lastActivity = Date.now();
      await this.save();
    }
    // Si entra un jugador, cambia su presencia y todos reciben el estado.
    if (color) this.broadcastState();
    else send(server, this.stateMsg());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const game = this.game;
    const msg = parse<ClientGameMsg>(message);
    if (!game || !msg) return;
    const me = ws.deserializeAttachment() as Attachment;
    const now = Date.now();
    const prev = game.status;

    if (msg.t === 'ping') return send(ws, PONG);
    if (msg.t === 'join') {
      if (me.color) return;
      const color = game.join(me.player, undefined, now);
      if (!color) return;
      ws.serializeAttachment({ ...me, color } satisfies Attachment);
      send(ws, { t: 'hello', you: color } satisfies ServerGameMsg);
      return this.commit(prev);
    }

    const color = me.color;
    if (!color) return send(ws, { t: 'error', msg: 'Eres espectador' } satisfies ServerGameMsg);

    switch (msg.t) {
      case 'move': {
        const err = game.move(color, String(msg.uci), Number(msg.ply), now);
        // Si la jugada se rechaza, reenviamos el estado para que el cliente se resincronice.
        if (err) {
          send(ws, { t: 'error', msg: err } satisfies ServerGameMsg);
          // Una jugada fuera de tiempo hace caer la bandera: eso sí es un cambio.
          if (game.status !== prev) return this.commit(prev);
          return send(ws, this.stateMsg());
        }
        return this.commit(prev);
      }
      case 'resign':
        game.resign(color, now);
        break;
      case 'abort':
        game.abort(color, now);
        break;
      case 'draw':
        game.draw(color, !!msg.offer, now);
        break;
      case 'rematch':
        return this.rematch(color, !!msg.offer, now);
      default:
        return;
    }
    return this.commit(prev);
  }

  async webSocketClose(ws: WebSocket) {
    // Con compatibility_date ≥ 2026-04-07 el runtime ya responde al cierre.
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me?.color) this.broadcastState(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  // ─── Alarmas: relojes y limpieza ───────────────────────────────────

  async alarm() {
    const game = this.game;
    if (!game) return;
    const now = Date.now();

    if (game.status === 'started') {
      const prev = game.status;
      if (game.tick(now)) return this.commit(prev);
    } else if (game.status === 'waiting') {
      if (now >= game.lastActivity + KEEP_WAITING_MS) return this.destroy();
    } else if (now >= (game.endedAt ?? now) + KEEP_FINISHED_MS) {
      if (this.ctx.getWebSockets().length === 0) {
        // Último intento de guardar en D1 si falló al terminar.
        if (await this.archive()) return this.destroy();
      }
      return this.ctx.storage.setAlarm(now + KEEP_FINISHED_MS);
    }
    // La alarma se adelantó o no había nada que hacer: reprogramar.
    await this.ctx.storage.setAlarm(this.nextAlarm());
  }

  /** Siguiente instante en que hay que mirar la partida. */
  private nextAlarm(): number {
    const game = this.game!;
    if (game.status === 'waiting') return game.lastActivity + KEEP_WAITING_MS;
    return game.nextDeadline() ?? (game.endedAt ?? Date.now()) + KEEP_FINISHED_MS;
  }

  private async destroy() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.game = null;
  }

  // ─── Interno ───────────────────────────────────────────────────────

  private async rematch(color: Color, offer: boolean, now: number) {
    const game = this.game!;
    if (!isOver(game.status)) return;
    if (!game.offerRematch(color, offer, now)) return this.commit(game.status);
    // Se marca antes de la llamada para que otro mensaje no cree una segunda revancha.
    const id = randomId();
    game.next = id;
    const { white, black } = game.rematchSeats();
    let ok = false;
    try {
      ok = await this.env.GAME_ROOM.getByName(id).pair(game.tc, white, black);
    } catch (err) {
      console.error('No se pudo crear la revancha', err);
    }
    if (!ok) {
      game.next = null;
      game.rematch.clear();
      return this.commit(game.status);
    }
    await this.save();
    this.broadcast(JSON.stringify({ t: 'redirect', id } satisfies ServerGameMsg));
  }

  /** Tras cada cambio: guardar, reprogramar la alarma, difundir y avisar a quien corresponda. */
  private async commit(prev: GameStatus) {
    const game = this.game!;
    await this.save();
    await this.ctx.storage.setAlarm(this.nextAlarm());
    this.broadcastState();

    const lobby = () => this.env.LOBBY.getByName('lobby');
    try {
      if (prev !== 'started' && game.status === 'started') await lobby().gameStarted(game.id);
      if (prev === 'started' && isOver(game.status)) await lobby().gameEnded(game.id);
    } catch (err) {
      console.error('No se pudo avisar al lobby', err);
    }
    if (!isOver(prev) && isOver(game.status)) await this.archive();
  }

  private save() {
    return this.ctx.storage.put(GAME_KEY, this.game!.toJSON());
  }

  /** Guarda la partida terminada en D1 (salvo las anuladas). Devuelve true si ya está. */
  private async archive(): Promise<boolean> {
    const game = this.game!;
    if (game.status === 'aborted' || !isOver(game.status)) return true;
    if (await this.ctx.storage.get<boolean>(ARCHIVED_KEY)) return true;
    try {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO games
          (id, initial, increment, white_player, black_player, status, winner, moves, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          game.id,
          game.tc.initial,
          game.tc.increment,
          game.seats.white ?? '',
          game.seats.black ?? '',
          game.status,
          game.winner,
          game.moves.join(' '),
          game.createdAt,
          game.endedAt ?? Date.now()
        )
        .run();
      await this.ctx.storage.put(ARCHIVED_KEY, true);
      return true;
    } catch (err) {
      console.error('No se pudo guardar la partida en D1', err);
      return false;
    }
  }

  /** Presencia calculada a partir de los sockets abiertos, no de contadores en memoria. */
  private online(except?: WebSocket): Record<Color, boolean> {
    const online = { white: false, black: false };
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.color) online[a.color] = true;
    }
    return online;
  }

  private stateMsg(except?: WebSocket): string {
    const msg: ServerGameMsg = { t: 'state', game: this.game!.view(Date.now(), this.online(except)) };
    return JSON.stringify(msg);
  }

  /** Envía el estado a todos los sockets menos `except` (que se está cerrando). */
  private broadcastState(except?: WebSocket) {
    this.broadcast(this.stateMsg(except), except);
  }

  private broadcast(msg: string, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) send(ws, msg);
  }
}
