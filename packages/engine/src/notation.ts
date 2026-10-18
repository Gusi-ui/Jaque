/** Inicial de cada pieza en SAN (inglés) y en español: caballo, alfil, torre, dama y rey. */
const SPANISH: Record<string, string> = { N: 'C', B: 'A', R: 'T', Q: 'D', K: 'R' };

/**
 * «Nf3» → «Cf3», «exd8=Q+» → «exd8=D+». Solo para mostrar: el protocolo y la lógica
 * siguen en SAN estándar. Las columnas van en minúscula y el enroque es O-O, así que
 * basta con cambiar las mayúsculas de pieza.
 */
export const spanishSan = (san: string) => san.replace(/[NBRQK]/g, (c) => SPANISH[c]);
