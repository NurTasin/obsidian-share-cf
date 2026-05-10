import MarkdownIt from "markdown-it";

export interface Env {
  DB: D1Database;
  NOTES: R2Bucket;
  PUBLIC_BASE_URL?: string;
}

interface RegisterBody {
  clientName?: string;
  clientVersion?: string;
}

interface UpsertNoteBody {
  noteId: string;
  path: string;
  title: string;
  content: string;
  contentHash: string;
  updatedAt?: string;
  assets?: UpsertAssetBody[];
}

interface UpsertAssetBody {
  assetId: string;
  originalPath: string;
  fileName: string;
  contentType: string;
  contentHash: string;
  sizeBytes: number;
  dataBase64: string;
}

interface VaultRow {
  id: string;
  token_hash: string;
}

interface NoteRow {
  id: string;
  vault_id: string;
  share_id: string;
  path: string;
  title: string;
  r2_key: string;
  content_hash: string;
  size_bytes: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

interface AssetRow {
  asset_id: string;
  r2_key: string;
  original_path: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  content_hash: string;
}

const encoder = new TextEncoder();
const markdownRenderer = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === "/api/register" && request.method === "POST") {
        return withCors(await registerVault(request, env));
      }

      if (url.pathname === "/api/notes" && request.method === "POST") {
        const vault = await authenticate(request, env);
        return withCors(await upsertNote(request, env, vault, url));
      }

      if (url.pathname === "/api/notes" && request.method === "GET") {
        const vault = await authenticate(request, env);
        return withCors(await listNotes(env, vault, url));
      }

      const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (noteMatch && request.method === "DELETE") {
        const vault = await authenticate(request, env);
        return withCors(await deleteNote(env, vault, decodeURIComponent(noteMatch[1])));
      }

      const shareMatch = url.pathname.match(/^\/s\/([^/]+)$/);
      if (shareMatch && request.method === "GET") {
        return renderSharedNote(env, decodeURIComponent(shareMatch[1]), url);
      }

      const assetMatch = url.pathname.match(/^\/assets\/([^/]+)\/([^/]+)$/);
      if (assetMatch && request.method === "GET") {
        return serveAsset(env, decodeURIComponent(assetMatch[1]), decodeURIComponent(assetMatch[2]));
      }

      const publicNoteMatch = url.pathname.match(/^\/api\/public\/notes\/([^/]+)$/);
      if (publicNoteMatch && request.method === "GET") {
        return withCors(await getPublicNote(env, decodeURIComponent(publicNoteMatch[1])));
      }

      if (url.pathname === "/health") {
        return json({ ok: true });
      }

      return text("Not found", 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return withCors(text(error.message, error.status));
      }

      console.error(error);
      return withCors(text("Internal server error", 500));
    }
  }
};

async function registerVault(request: Request, env: Env): Promise<Response> {
  const body = await readJson<RegisterBody>(request);
  const now = new Date().toISOString();
  const vaultId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);

  await env.DB.prepare(
    `INSERT INTO vaults (id, token_hash, client_name, client_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(vaultId, tokenHash, body.clientName ?? null, body.clientVersion ?? null, now, now)
    .run();

  return json({ vaultId, clientToken: `${vaultId}.${token}` }, 201);
}

async function upsertNote(request: Request, env: Env, vault: VaultRow, url: URL): Promise<Response> {
  const body = await readJson<UpsertNoteBody>(request);
  validateNoteBody(body);

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT * FROM notes WHERE vault_id = ? AND id = ?`
  )
    .bind(vault.id, body.noteId)
    .first<NoteRow>();

  const shareId = existing?.share_id ?? randomSlug();
  const r2Key = existing?.r2_key ?? `notes/${vault.id}/${body.noteId}.md`;
  const assets = body.assets ?? [];
  const storedContent = rewriteAssetPlaceholders(body.content, shareId);
  const contentBytes = encoder.encode(storedContent);

  await env.NOTES.put(r2Key, storedContent, {
    httpMetadata: {
      contentType: "text/markdown; charset=utf-8"
    },
    customMetadata: {
      vaultId: vault.id,
      noteId: body.noteId,
      contentHash: body.contentHash
    }
  });

  if (existing) {
    await env.DB.prepare(
      `UPDATE notes
       SET path = ?, title = ?, content_hash = ?, size_bytes = ?, is_deleted = 0, updated_at = ?
       WHERE vault_id = ? AND id = ?`
    )
      .bind(body.path, body.title, body.contentHash, contentBytes.byteLength, body.updatedAt ?? now, vault.id, body.noteId)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO notes
       (id, vault_id, share_id, path, title, r2_key, content_hash, size_bytes, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(
        body.noteId,
        vault.id,
        shareId,
        body.path,
        body.title,
        r2Key,
        body.contentHash,
        contentBytes.byteLength,
        now,
        body.updatedAt ?? now
      )
      .run();
  }

  await upsertAssets(env, vault, body.noteId, shareId, assets, now);

  return json({
    noteId: body.noteId,
    shareId,
    url: `${publicBaseUrl(env, url)}/s/${shareId}`
  });
}

async function listNotes(env: Env, vault: VaultRow, url: URL): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, share_id, path, title, content_hash, size_bytes, updated_at
     FROM notes
     WHERE vault_id = ? AND is_deleted = 0
     ORDER BY path COLLATE NOCASE`
  )
    .bind(vault.id)
    .all<Pick<NoteRow, "id" | "share_id" | "path" | "title" | "content_hash" | "size_bytes" | "updated_at">>();

  const baseUrl = publicBaseUrl(env, url);
  return json({
    notes: results.map((note) => ({
      noteId: note.id,
      shareId: note.share_id,
      path: note.path,
      title: note.title,
      contentHash: note.content_hash,
      sizeBytes: note.size_bytes,
      updatedAt: note.updated_at,
      url: `${baseUrl}/s/${note.share_id}`
    }))
  });
}

async function deleteNote(env: Env, vault: VaultRow, noteId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r2_key FROM notes WHERE vault_id = ? AND id = ?`
  )
    .bind(vault.id, noteId)
    .first<{ r2_key: string }>();

  if (!row) {
    return json({ ok: true });
  }

  await env.DB.prepare(
    `UPDATE notes SET is_deleted = 1, updated_at = ? WHERE vault_id = ? AND id = ?`
  )
    .bind(new Date().toISOString(), vault.id, noteId)
    .run();
  await env.NOTES.delete(row.r2_key);
  await deleteNoteAssets(env, vault.id, noteId);

  return json({ ok: true });
}

async function renderSharedNote(env: Env, shareId: string, url: URL): Promise<Response> {
  const note = await env.DB.prepare(
    `SELECT * FROM notes WHERE share_id = ? AND is_deleted = 0`
  )
    .bind(shareId)
    .first<NoteRow>();

  if (!note) {
    return html(renderPage("Note not found", "This share link is no longer available."), 404);
  }

  const object = await env.NOTES.get(note.r2_key);
  if (!object) {
    return html(renderPage("Note unavailable", "The note metadata exists, but the note object is missing."), 404);
  }

  const markdown = await object.text();
  return html(renderPage(note.title, markdownRenderer.render(markdown), note.updated_at, importIntoObsidianUrl(env, url, shareId)));
}

async function serveAsset(env: Env, shareId: string, assetId: string): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT note_assets.*
     FROM note_assets
     INNER JOIN notes ON notes.vault_id = note_assets.vault_id AND notes.id = note_assets.note_id
     WHERE notes.share_id = ? AND notes.is_deleted = 0 AND note_assets.asset_id = ?`
  )
    .bind(shareId, assetId)
    .first<AssetRow>();

  if (!asset) {
    return text("Not found", 404);
  }

  const object = await env.NOTES.get(asset.r2_key);
  if (!object) {
    return text("Not found", 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": asset.content_type,
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  });
}

async function getPublicNote(env: Env, shareId: string): Promise<Response> {
  const note = await env.DB.prepare(
    `SELECT * FROM notes WHERE share_id = ? AND is_deleted = 0`
  )
    .bind(shareId)
    .first<NoteRow>();

  if (!note) {
    throw new HttpError(404, "Note not found.");
  }

  const object = await env.NOTES.get(note.r2_key);
  if (!object) {
    throw new HttpError(404, "Note unavailable.");
  }

  const { results: assets } = await env.DB.prepare(
    `SELECT asset_id, original_path, file_name, content_type, size_bytes, content_hash
     FROM note_assets
     WHERE vault_id = ? AND note_id = ?
     ORDER BY original_path COLLATE NOCASE`
  )
    .bind(note.vault_id, note.id)
    .all<Pick<AssetRow, "asset_id" | "original_path" | "file_name" | "content_type" | "size_bytes" | "content_hash">>();

  return json({
    shareId,
    path: note.path,
    title: note.title,
    content: await object.text(),
    updatedAt: note.updated_at,
    assets: assets.map((asset) => ({
      assetId: asset.asset_id,
      originalPath: asset.original_path,
      fileName: asset.file_name,
      contentType: asset.content_type,
      sizeBytes: asset.size_bytes,
      contentHash: asset.content_hash,
      url: `/assets/${encodeURIComponent(shareId)}/${encodeURIComponent(asset.asset_id)}`
    }))
  });
}

async function upsertAssets(env: Env, vault: VaultRow, noteId: string, shareId: string, assets: UpsertAssetBody[], now: string) {
  const keep = new Set<string>();

  for (const asset of assets) {
    validateAsset(asset);
    keep.add(asset.assetId);

    const bytes = base64ToBytes(asset.dataBase64);
    if (bytes.byteLength !== asset.sizeBytes) {
      throw new HttpError(400, `Asset ${asset.originalPath} size does not match payload.`);
    }

    const r2Key = `assets/${vault.id}/${noteId}/${asset.assetId}`;
    await env.NOTES.put(r2Key, bytes, {
      httpMetadata: {
        contentType: asset.contentType
      },
      customMetadata: {
        vaultId: vault.id,
        noteId,
        shareId,
        originalPath: asset.originalPath,
        contentHash: asset.contentHash
      }
    });

    await env.DB.prepare(
      `INSERT INTO note_assets
       (vault_id, note_id, asset_id, r2_key, original_path, file_name, content_type, size_bytes, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault_id, note_id, asset_id) DO UPDATE SET
         r2_key = excluded.r2_key,
         original_path = excluded.original_path,
         file_name = excluded.file_name,
         content_type = excluded.content_type,
         size_bytes = excluded.size_bytes,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`
    )
      .bind(vault.id, noteId, asset.assetId, r2Key, asset.originalPath, asset.fileName, asset.contentType, asset.sizeBytes, asset.contentHash, now, now)
      .run();
  }

  const { results: existingAssets } = await env.DB.prepare(
    `SELECT asset_id, r2_key FROM note_assets WHERE vault_id = ? AND note_id = ?`
  )
    .bind(vault.id, noteId)
    .all<Pick<AssetRow, "asset_id" | "r2_key">>();

  for (const asset of existingAssets) {
    if (keep.has(asset.asset_id)) continue;
    await env.NOTES.delete(asset.r2_key);
    await env.DB.prepare(
      `DELETE FROM note_assets WHERE vault_id = ? AND note_id = ? AND asset_id = ?`
    )
      .bind(vault.id, noteId, asset.asset_id)
      .run();
  }
}

async function deleteNoteAssets(env: Env, vaultId: string, noteId: string) {
  const { results } = await env.DB.prepare(
    `SELECT asset_id, r2_key FROM note_assets WHERE vault_id = ? AND note_id = ?`
  )
    .bind(vaultId, noteId)
    .all<Pick<AssetRow, "asset_id" | "r2_key">>();

  for (const asset of results) {
    await env.NOTES.delete(asset.r2_key);
  }

  await env.DB.prepare(`DELETE FROM note_assets WHERE vault_id = ? AND note_id = ?`)
    .bind(vaultId, noteId)
    .run();
}

async function authenticate(request: Request, env: Env): Promise<VaultRow> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing bearer token.");
  }

  const token = header.slice("Bearer ".length);
  const [vaultId, secret] = token.split(".", 2);
  if (!vaultId || !secret) {
    throw new HttpError(401, "Invalid bearer token.");
  }

  const vault = await env.DB.prepare("SELECT * FROM vaults WHERE id = ?")
    .bind(vaultId)
    .first<VaultRow>();

  if (!vault) {
    throw new HttpError(401, "Unknown vault.");
  }

  const tokenHash = await sha256Hex(secret);
  if (tokenHash !== vault.token_hash) {
    throw new HttpError(401, "Invalid bearer token.");
  }

  await env.DB.prepare("UPDATE vaults SET updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), vault.id)
    .run();

  return vault;
}

function validateNoteBody(body: UpsertNoteBody) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Request body must be JSON.");
  if (!body.noteId || !isUuid(body.noteId)) throw new HttpError(400, "noteId must be a UUID.");
  if (!body.path || body.path.length > 1024) throw new HttpError(400, "path is required and must be under 1024 characters.");
  if (!body.title || body.title.length > 300) throw new HttpError(400, "title is required and must be under 300 characters.");
  if (typeof body.content !== "string") throw new HttpError(400, "content is required.");
  if (!/^[a-f0-9]{64}$/i.test(body.contentHash)) throw new HttpError(400, "contentHash must be a SHA-256 hex digest.");
  if (body.assets !== undefined && !Array.isArray(body.assets)) throw new HttpError(400, "assets must be an array.");
}

function validateAsset(asset: UpsertAssetBody) {
  if (!asset || typeof asset !== "object") throw new HttpError(400, "Each asset must be an object.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/i.test(asset.assetId)) {
    throw new HttpError(400, "assetId must be a UUID filename with an extension.");
  }
  if (!asset.originalPath || asset.originalPath.length > 1024) throw new HttpError(400, "asset originalPath is required.");
  if (!asset.fileName || asset.fileName.length > 260) throw new HttpError(400, "asset fileName is required.");
  if (!asset.contentType || asset.contentType.length > 100) throw new HttpError(400, "asset contentType is required.");
  if (!/^[a-f0-9]{64}$/i.test(asset.contentHash)) throw new HttpError(400, "asset contentHash must be a SHA-256 hex digest.");
  if (!Number.isInteger(asset.sizeBytes) || asset.sizeBytes < 0) throw new HttpError(400, "asset sizeBytes must be a positive integer.");
  if (!asset.dataBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.dataBase64)) throw new HttpError(400, "asset dataBase64 is required.");
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function renderPage(title: string, body: string, updatedAt?: string, importUrl?: string): string {
  const escapedTitle = escapeHtml(title);
  const updated = updatedAt
    ? `<time datetime="${escapeHtml(updatedAt)}">Updated ${escapeHtml(new Date(updatedAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }))}</time>`
    : "";
  const importButton = importUrl
    ? `<a class="import-button" href="${escapeHtml(importUrl)}">Pull into Obsidian</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { margin: 0 auto; max-width: 760px; padding: 40px 20px 64px; }
    header { border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); margin-bottom: 28px; padding-bottom: 20px; }
    .header-row { align-items: start; display: flex; gap: 16px; justify-content: space-between; }
    h1 { font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.05; margin: 0 0 12px; }
    .import-button { background: CanvasText; border-radius: 7px; color: Canvas; display: inline-flex; flex: 0 0 auto; font-size: 0.92rem; font-weight: 650; line-height: 1; padding: 12px 14px; text-decoration: none; }
    .import-button:hover { opacity: 0.86; }
    time { color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 0.92rem; }
    article { font-size: 1.05rem; line-height: 1.7; }
    article h1, article h2, article h3 { line-height: 1.2; margin-top: 1.5em; }
    article img { height: auto; max-width: 100%; }
    article table { border-collapse: collapse; display: block; overflow-x: auto; width: max-content; max-width: 100%; }
    article th, article td { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: 6px 10px; }
    article blockquote { border-left: 3px solid color-mix(in srgb, CanvasText 28%, transparent); margin-left: 0; padding-left: 16px; color: color-mix(in srgb, CanvasText 78%, transparent); }
    pre { background: color-mix(in srgb, CanvasText 8%, transparent); border-radius: 8px; overflow: auto; padding: 16px; }
    code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
    @media (max-width: 620px) {
      .header-row { display: block; }
      .import-button { margin: 8px 0 14px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="header-row">
        <h1>${escapedTitle}</h1>
        ${importButton}
      </div>
      ${updated}
    </header>
    <article>${body}</article>
  </main>
</body>
</html>`;
}

function importIntoObsidianUrl(env: Env, url: URL, shareId: string): string {
  const params = new URLSearchParams({
    mode: "import",
    shareId,
    workerUrl: publicBaseUrl(env, url)
  });
  return `obsidian://sharecf?${params.toString()}`;
}

function rewriteAssetPlaceholders(content: string, shareId: string): string {
  return content.replace(/share-cf-asset:\/\/([0-9a-f-]+\.[a-z0-9]+)/gi, (_match, assetId: string) => (
    `/assets/${encodeURIComponent(shareId)}/${encodeURIComponent(assetId)}`
  ));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function publicBaseUrl(env: Env, url: URL): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || url.origin;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function randomToken(): string {
  return randomBytesUrl(32);
}

function randomSlug(): string {
  return randomBytesUrl(12);
}

function randomBytesUrl(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
