# Problema del día

## Problema

Quien entra en la portada y no encuentra rival no tiene nada que hacer mientras
espera, salvo aceptar el reto de la máquina. Si se va, la sala sigue vacía.

## Objetivo

Un problema de ajedrez al día, el mismo para todos, que se resuelve en la propia
portada sin registro. Da un motivo para quedarse (y para volver mañana) mientras la
búsqueda de rival sigue abierta. No sustituye a jugar contra personas: va debajo del
lobby.

Criterio de éxito: se puede resolver, fallar, pedir pista y ver la solución en
escritorio y en móvil; al volver el mismo día se ve el resultado; al día siguiente
hay otro problema.

Fuera de alcance: contador de cuánta gente lo ha resuelto, rachas, página propia,
«DameJaque TV».

## Diseño

### 1. Datos: la lista de problemas

- **Origen:** base de problemas abierta de lichess (`lichess_db_puzzle.csv.zst`,
  licencia CC0). CC0 no exige atribución: la página no menciona la fuente.
- **Script** `packages/engine/scripts/build-puzzles.ts` (script `puzzles` del
  paquete): lee el CSV por la entrada estándar y escribe
  `packages/engine/src/puzzles.json`. Se ejecuta a mano y el JSON se sube al repo:
  ```
  curl -L https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -d | pnpm --filter @jaque/engine puzzles
  ```
- **Columnas usadas:** `PuzzleId, FEN, Moves, Rating, RatingDeviation, Popularity,
  NbPlays, Themes`. En el CSV la primera jugada de `Moves` es la del rival: el script
  la aplica, y guarda el FEN resultante y el resto de jugadas (la solución).
- **Calidad:** tema `mateIn1`, `mateIn2` o `mateIn3`; `Popularity ≥ 90`;
  `NbPlays ≥ 1000`; `RatingDeviation < 80`.
- **Un grupo por día de la semana**, 53 problemas cada uno (un año sin repetir):

  | Día       | Tipo      | Elo       |
  | --------- | --------- | --------- |
  | Lunes     | mate en 1 | 600–1000  |
  | Martes    | mate en 1 | 1000–1400 |
  | Miércoles | mate en 2 | 1000–1300 |
  | Jueves    | mate en 2 | 1300–1600 |
  | Viernes   | mate en 2 | 1600–1900 |
  | Sábado    | mate en 3 | 1400–1800 |
  | Domingo   | mate en 3 | 1800–2200 |

  Dentro de cada grupo el script elige los 53 más populares (desempate por `NbPlays`)
  y los ordena por id, para que la salida sea estable.
- **Formato:** `{ "v": 1, "days": [grupo lunes, …, grupo domingo] }`, donde cada
  problema es `[id, fen, "uci uci …", elo]`. Unos 40 KB (≈15 KB comprimido).
- La web lo carga con `import()` dinámico: no pesa en la carga inicial.

### 2. Lógica: `@jaque/engine/puzzle`

Módulo puro `packages/engine/src/puzzle.ts`, exportado como `@jaque/engine/puzzle`.

- `dayKey(now: Date): string` — fecha en Europa/Madrid, `'YYYY-MM-DD'`
  (`Intl.DateTimeFormat` con `timeZone: 'Europe/Madrid'`).
- `puzzleOfDay(now: Date, data: PuzzleData): DailyPuzzle` — día de la semana de esa
  fecha → grupo; índice = semanas desde una fecha fija (lunes 2026-01-05) `mod` tamaño
  del grupo. Devuelve `{ key, id, fen, solution: string[], goal: 1 | 2 | 3 }`.
- `class PuzzleRun` sobre chess.js:
  - `play(uci)` → `'wrong'`, `{ reply: string }` (acierto; jugada del rival ya
    aplicada) o `'solved'`.
  - Cualquier jugada que dé mate cuenta como resuelto, sea o no la de la solución.
  - Las coronaciones se comparan con la pieza incluida.
  - `hint()` → casilla de la pieza que hay que mover; `rest()` → jugadas que quedan.
  - `fen`, `turn`, `dests` para el tablero.

### 3. Interfaz en la portada

`apps/web/src/lib/DailyPuzzle.svelte`, en `+page.svelte` entre la sección del lobby y
«Juega al ajedrez en segundos». Reutiliza `Board.svelte`.

- **Título** «Problema del día»; línea «Juegan blancas · Mate en 2».
- **Disposición:** escritorio, tablero ≈300 px a la izquierda y texto a la derecha;
  móvil, tablero a todo el ancho (máx. ≈360 px) y texto debajo. Mientras carga el JSON
  se reserva el hueco del tablero (sin saltos de maquetación).
- **Tablero** orientado al bando que mueve; solo se mueven sus piezas.
- **Jugada mala:** la pieza vuelve (`cancelMove`) y «Esa no es. Prueba otra vez.»
- **Jugada buena:** a los 350 ms contesta el rival, con el sonido de jugada; «¡Bien!
  Sigue.»
- **Resuelto:** «¡Resuelto! Vuelve mañana para otro.» Tablero quieto, sin botones.
- **Pista:** círculo dorado en la casilla de la pieza que hay que mover. `Board.svelte`
  gana una prop opcional `shapes` (`autoShapes` de chessground).
- **Ver solución:** reproduce las jugadas que quedan, una cada 600 ms, y termina con
  «Esta era la solución. Mañana, otro.»
- **Recuerdo del día:** `localStorage` clave `jaque:problema`,
  `{ key, result: 'solved' | 'shown' }`, lectura y escritura en try/catch. Si coincide
  `key`, se muestra la posición final con su mensaje.
- **Reto de la máquina:** el componente llama a `onactivity` en la primera
  interacción (jugada, pista o solución). La portada anula el temporizador del reto y
  cierra la tarjeta si estaba abierta.
- **Rival encontrado** mientras se resuelve: como siempre, se va a la partida.
- **Accesibilidad:** `<section aria-labelledby>`, mensaje con `role="status"`,
  botones reales.

## Comprobación

- `packages/engine/test/puzzle.test.ts`:
  - `dayKey` cambia a medianoche de Madrid (22:30 UTC en verano ya es el día
    siguiente).
  - Cada día de la semana usa su grupo; misma fecha, mismo problema.
  - `PuzzleRun`: acierto, fallo, mate alternativo, mate en 3 completo, coronación.
  - Integridad del JSON: 7 grupos de 53; cada solución es legal y acaba en mate, y el
    número de jugadas propias coincide con el grupo (1, 2 o 3).
- `pnpm check`, `pnpm test`, `pnpm build`.
- En el navegador (`localhost:5173`), escritorio y móvil: resolver, fallar, pista,
  solución, volver a la portada el mismo día.
