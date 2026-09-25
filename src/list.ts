import { normalizeEmail, sha256Hex } from "./text";

export type NoteState = "pending" | "sent" | "failed";

export type Entry = {
  email: string;
  at: string;
  note: NoteState;
  noteAt?: string;
};

export interface WaitlistKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

const PREFIX = "e:";

export async function emailKey(email: string): Promise<string> {
  const hex = await sha256Hex(email);
  return `${PREFIX}${hex.slice(0, 32)}`;
}

export function parseEntry(raw: string | null): Entry | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<Entry>;
    const email = normalizeEmail(String(data.email ?? ""));
    if (!email || typeof data.at !== "string") return null;
    const note =
      data.note === "sent" || data.note === "failed" || data.note === "pending"
        ? data.note
        : "pending";
    return {
      email,
      at: data.at,
      note,
      noteAt: typeof data.noteAt === "string" ? data.noteAt : undefined,
    };
  } catch {
    return null;
  }
}

export async function readEntry(
  kv: WaitlistKv,
  email: string,
): Promise<Entry | null> {
  return parseEntry(await kv.get(await emailKey(email)));
}

export async function writeEntry(kv: WaitlistKv, entry: Entry): Promise<void> {
  await kv.put(await emailKey(entry.email), JSON.stringify(entry));
}

export async function deleteEntry(kv: WaitlistKv, email: string): Promise<void> {
  await kv.delete(await emailKey(email));
}

/** Hashed counters only. The address list is a different prefix. */
export async function bumpedLimit(
  kv: WaitlistKv,
  bucket: string,
  ip: string,
  limit: number,
): Promise<boolean> {
  const hex = (await sha256Hex(`${bucket}:${ip || "unknown"}`)).slice(0, 32);
  const key = `${bucket}:${hex}`;
  const hits = Number((await kv.get(key)) || "0");
  if (hits >= limit) return true;
  await kv.put(key, String(hits + 1), { expirationTtl: 3600 });
  return false;
}

export async function listEntries(kv: WaitlistKv, cap = 500): Promise<{
  entries: Entry[];
  truncated: boolean;
}> {
  const entries: Entry[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor, limit: 100 });
    for (const key of page.keys) {
      if (entries.length >= cap) {
        truncated = true;
        break;
      }
      const entry = parseEntry(await kv.get(key.name));
      if (entry) entries.push(entry);
    }
    if (truncated) break;
    cursor = page.list_complete ? undefined : page.cursor;
    if (!page.list_complete && !cursor) break;
  } while (cursor);
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { entries, truncated };
}
