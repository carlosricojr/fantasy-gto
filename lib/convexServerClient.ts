import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

let client: ConvexHttpClient | null = null;
export function getConvexServerClient() {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not set");
    client = new ConvexHttpClient(url);
  }
  return client;
}
export { api };


