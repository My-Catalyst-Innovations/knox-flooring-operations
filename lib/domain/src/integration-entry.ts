export const quickBooksEntryPaths = {
  launch: "/integrations/quickbooks/launch",
  connect: "/integrations/quickbooks/connect",
  reconnect: "/integrations/quickbooks/reconnect",
  disconnect: "/integrations/quickbooks/disconnect",
} as const;
export type QuickBooksEntryIntent = keyof typeof quickBooksEntryPaths;
const continuations = {
  quickbooks_launch: quickBooksEntryPaths.launch,
  quickbooks_connect: quickBooksEntryPaths.connect,
  quickbooks_reconnect: quickBooksEntryPaths.reconnect,
  quickbooks_disconnect: quickBooksEntryPaths.disconnect,
} as const;

/** This accepts a closed intent, never an arbitrary return URL. */
export function welcomeContinuation(search: string): string {
  const values: string[] = [];
  try {
    for (const pair of search.replace(/^\?/, "").split("&")) {
      const separator = pair.indexOf("=");
      const decode = (value: string) =>
        decodeURIComponent(value.replace(/\+/g, " "));
      if (
        decode(separator < 0 ? pair : pair.slice(0, separator)) === "continue"
      )
        values.push(decode(separator < 0 ? "" : pair.slice(separator + 1)));
    }
  } catch {
    return "/";
  }
  return values.length === 1 && Object.hasOwn(continuations, values[0])
    ? continuations[values[0] as keyof typeof continuations]
    : "/";
}
export const quickBooksSignInPath = (intent: QuickBooksEntryIntent) =>
  `/welcome?continue=quickbooks_${intent}`;
