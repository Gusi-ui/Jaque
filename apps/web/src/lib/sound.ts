// Sonidos sintetizados con Web Audio: sin archivos que descargar.
let ctx: AudioContext | null = null;

function tone(freq: number, dur: number, gain: number, type: OscillatorType = 'triangle') {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch {
    /* sin audio disponible */
  }
}

export const sound = {
  move: () => tone(420, 0.07, 0.25),
  capture: () => (tone(260, 0.1, 0.35), tone(520, 0.05, 0.12)),
  check: () => tone(700, 0.12, 0.18, 'square'),
  end: () => (tone(520, 0.18, 0.2), setTimeout(() => tone(390, 0.3, 0.2), 160)),
  start: () => tone(600, 0.12, 0.15)
};
