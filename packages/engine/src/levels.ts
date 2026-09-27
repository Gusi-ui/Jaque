// Niveles de la máquina, aparte del motor para que la interfaz pueda mostrarlos
// sin cargar la búsqueda (chessops).
export type BotLevel = 1 | 2 | 3;

export const BOT_LEVELS: Record<BotLevel, string> = { 1: 'Fácil', 2: 'Medio', 3: 'Difícil' };
