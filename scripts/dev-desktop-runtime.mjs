import net from "node:net";

export async function resolveDesktopDevPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("CODIA_DEV_DESKTOP_PORT must be an integer between 0 and 65535.");
  }
  if (port !== 0) return port;
  // Vite treats port=0 as its default port. Resolve an OS-assigned port first;
  // strictPort remains enabled so a subsequent collision fails explicitly.
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
