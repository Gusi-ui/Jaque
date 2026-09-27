import { Game as Engine } from '@jaque/engine';
import type { Color, GameView, TimeControl } from '@jaque/shared';

export { FIRST_MOVE_MS } from '@jaque/engine';

/**
 * Una partida en memoria: el motor de `@jaque/engine` con el reloj de pared
 * (`Date.now()`), un único `setTimeout` para la bandera o la anulación y
 * contadores de conexiones por asiento.
 */
export class Game extends Engine {
  readonly online: Record<Color, number> = { white: 0, black: 0 };
  private timer: NodeJS.Timeout | undefined;

  constructor(id: string, tc: TimeControl) {
    super(id, tc, Date.now());
  }

  override remaining(c: Color, now = Date.now()) {
    return super.remaining(c, now);
  }

  override join(player: string, prefer?: Color, now = Date.now()) {
    return super.join(player, prefer, now);
  }

  override move(color: Color, uci: string, ply?: number, now = Date.now()) {
    return super.move(color, uci, ply, now);
  }

  override resign(color: Color, now = Date.now()) {
    super.resign(color, now);
  }

  override abort(color: Color, now = Date.now()) {
    super.abort(color, now);
  }

  override draw(color: Color, offer: boolean, now = Date.now()) {
    super.draw(color, offer, now);
  }

  override offerRematch(color: Color, offer: boolean, now = Date.now()) {
    return super.offerRematch(color, offer, now);
  }

  setOnline(color: Color, delta: 1 | -1) {
    this.online[color] = Math.max(0, this.online[color] + delta);
    this.changed(Date.now());
  }

  override view(now = Date.now()): GameView {
    return super.view(now, { white: this.online.white > 0, black: this.online.black > 0 });
  }

  /** Cada cambio reprograma el único temporizador de la partida. */
  protected override changed(now: number) {
    this.schedule();
    super.changed(now);
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const deadline = this.nextDeadline();
    if (deadline === null) return;
    this.timer = setTimeout(() => {
      // Si el temporizador se adelanta, tick no cambia nada y se vuelve a programar.
      if (!this.tick(Date.now())) this.schedule();
    }, deadline - Date.now());
    this.timer.unref?.();
  }

  dispose() {
    clearTimeout(this.timer);
    this.onChange = () => {};
  }
}
