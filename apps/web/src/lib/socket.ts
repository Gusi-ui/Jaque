export type SocketStatus = 'connecting' | 'open' | 'closed';

interface Options<In> {
  onMessage: (msg: In) => void;
  onStatus?: (s: SocketStatus) => void;
}

/**
 * WebSocket que se reconecta solo, con espera creciente (0,5 s → 5 s).
 * Tras reconectar, el servidor vuelve a mandar el estado completo.
 */
export function connect<In, Out>(path: string, { onMessage, onStatus }: Options<In>) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  let ws: WebSocket | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = () => {
    onStatus?.('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      onStatus?.('open');
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('Mensaje no válido', err);
      }
    };
    ws.onclose = () => {
      onStatus?.('closed');
      if (closed) return;
      timer = setTimeout(open, Math.min(5000, 500 * 2 ** retry++));
    };
  };

  // Al volver a la pestaña en el móvil, reconectar enseguida.
  const onVisible = () => {
    if (document.visibilityState === 'visible' && ws?.readyState === WebSocket.CLOSED) {
      clearTimeout(timer);
      open();
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  open();

  return {
    send(msg: Out): boolean {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    }
  };
}
