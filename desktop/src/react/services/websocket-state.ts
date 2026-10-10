let resolveActiveWebSocket: () => WebSocket | null = () => null;

export function configureActiveWebSocketResolver(resolver: () => WebSocket | null): void {
  resolveActiveWebSocket = resolver;
}

export function getActiveWebSocket(): WebSocket | null {
  return resolveActiveWebSocket();
}
