-- Historial: partidas terminadas (las anuladas no se guardan).
-- Instantes en milisegundos desde 1970 (Date.now()).
CREATE TABLE games (
  id           TEXT PRIMARY KEY,
  initial      INTEGER NOT NULL, -- segundos
  increment    INTEGER NOT NULL, -- segundos
  white_player TEXT NOT NULL,
  black_player TEXT NOT NULL,
  status       TEXT NOT NULL,    -- mate, resign, timeout, draw…
  winner       TEXT,             -- white, black o NULL si tablas
  moves        TEXT NOT NULL,    -- UCI separado por espacios
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER NOT NULL
);

CREATE INDEX games_white_player ON games (white_player, ended_at);
CREATE INDEX games_black_player ON games (black_player, ended_at);
