# Arranque con la sala vacía

## Problema

Quien entra en la portada ve que no hay nadie («1 jugador conectado, 0 partidas en
juego», y ese 1 es él), busca rival, espera sin fin y se va. Y como se va, la sala
sigue vacía.

## Objetivo

Que el visitante pueda jugar en segundos aunque no haya nadie más, y que la portada
no anuncie el vacío. Sin engañar: la máquina siempre se presenta como máquina.

Fuera de alcance: «DameJaque TV», problema del día y mantener la búsqueda abierta
durante una partida contra la máquina.

## Diseño

### 1. Crear partida: una sola función

En `apps/web/src/routes/+page.svelte`, la lógica de `createFriendGame` pasa a
`createGame(tc, color, botLevel?)`: `POST /api/games` → `saveBot` si hay nivel →
cancela la búsqueda si la hay → `goto`. La usan el diálogo, «Jugar ya» y la oferta
tras esperar.

### 2. Botón «Jugar ya»

- Botón principal bajo el subtítulo, antes de la parrilla: «Jugar ya contra la
  máquina», con la línea «5+3 · nivel fácil» (el nivel que toque).
- Ritmo 5+3, color al azar, nivel **fácil** por defecto. Si el visitante eligió un
  nivel en el diálogo, se recuerda en `localStorage` (clave `jaque:bot-level`,
  lectura y escritura en try/catch) y «Jugar ya» usa ese.
- Los botones de abajo quedan como «Jugar con un amigo» y «Configurar partida
  contra la máquina».
- Subtítulo: «Juega ya contra la máquina o elige un ritmo y te emparejamos con
  alguien.»

### 3. Oferta tras esperar

- Al empezar a buscar se arranca un temporizador de **12 s** en el cliente; se
  anula al cancelar, al emparejar o al salir de la página.
- Si vence y la búsqueda sigue activa, bajo la parrilla aparece «No hay nadie libre
  ahora mismo.» y el botón «Jugar {ritmo} contra la máquina», con el ritmo buscado
  y el nivel recordado (fácil por defecto).
- La búsqueda sigue abierta hasta que pulse: si llega una persona antes, se
  empareja como siempre. Al pulsar se cancela la búsqueda y empieza la partida.
- Sin cambios en el servidor.

### 4. Estadísticas sin vacío

Protocolo: `ServerLobbyMsg` `stats` gana `played: number`, partidas terminadas
(no anuladas) desde siempre.

- **Worker**: el `Lobby` guarda `played` en su SQLite. Si no existe, lo inicializa
  una vez con `SELECT COUNT(*) FROM games` en D1. `GameRoom` avisa de los finales
  no anulados (tras guardar en D1) y el `Lobby` incrementa el contador. Nunca se
  consulta D1 en cada difusión.
- **Servidor (VPS)**: contador en memoria desde el arranque, incrementado en el
  mismo punto donde termina una partida no anulada.

Portada (pie de estadísticas):

1. `players >= 3`: se muestra el directo como ahora.
2. Si no, y `played >= 50`: «{played} partidas jugadas en DameJaque» (con
   separador de miles, `toLocaleString('es')`).
3. Si no: no se muestra nada.

«N personas esperan» en cada casilla se mantiene.

## Pruebas

- Worker: `played` sube al terminar una partida y no sube al anularla.
- Servidor: lo mismo con el contador en memoria.
- `pnpm check`, `pnpm test`, `pnpm build` en verde.
- A mano con `pnpm dev`: la oferta a los 12 s, «Jugar ya» y el pie de estadísticas.
