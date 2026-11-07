import type { Client } from "@colyseus/sdk";

export function multiplayerEndpoint(override?: string): string {
  const configured = override ?? import.meta.env.VITE_CRYPTBALL_SERVER;
  if (configured) return configured;
  if (
    typeof location !== "undefined" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  )
    return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:2567`;
  throw Error(
    "Online play is not configured for this website yet. Solo and Practice are available.",
  );
}

// A reloaded tab can reach the server before it has observed the old socket
// closing and reserved its seat. Both group and court connections have this race.
export async function reconnectAfterReload(client: Client, token: string) {
  for (const delay of [100, 250]) {
    try {
      return await client.reconnect(token);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return client.reconnect(token);
}
