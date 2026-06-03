import { parseSignalMessagePayload, type SignalMessage } from "../shared/protocol";

export interface SignalSocket {
  send: (message: SignalMessage) => void;
  close: () => void;
}

export function openSignalSocket(
  path: string,
  handlers: {
    onOpen?: () => void;
    onMessage: (message: SignalMessage) => void;
    onClose?: () => void;
    onError?: () => void;
  }
): SignalSocket {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);

  socket.addEventListener("open", () => handlers.onOpen?.());
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      handlers.onError?.();
      return;
    }

    const message = parseSignalMessagePayload(event.data);
    if (!message) {
      handlers.onError?.();
      return;
    }

    handlers.onMessage(message);
  });
  socket.addEventListener("close", () => handlers.onClose?.());
  socket.addEventListener("error", () => handlers.onError?.());

  return {
    send(message) {
      const payload = JSON.stringify(message);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
        return;
      }
      socket.addEventListener("open", () => socket.send(payload), { once: true });
    },
    close() {
      socket.close();
    }
  };
}
