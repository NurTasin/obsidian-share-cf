import {
  App,
  Modal,
  Notice,
  ObsidianProtocolData,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TAbstractFile,
  TFile,
  TFolder
} from "obsidian";

interface SharedNoteRecord {
  noteId: string;
  shareId: string;
  url: string;
  path: string;
  title: string;
  assets?: Record<string, SharedAssetRecord>;
  lastSyncedHash?: string;
  lastSyncedAt?: number;
}

interface SharedAssetRecord {
  assetId: string;
  contentHash: string;
  fileName: string;
}

interface UploadAsset {
  assetId: string;
  originalPath: string;
  fileName: string;
  contentType: string;
  contentHash: string;
  sizeBytes: number;
  dataBase64: string;
}

interface PreparedUpload {
  content: string;
  contentHash: string;
  assets: UploadAsset[];
  assetRecords: Record<string, SharedAssetRecord>;
}

interface ImageReferenceMatch {
  originalReference: string;
  target: string;
  toReference: (url: string) => string;
}

interface PublicNotePayload {
  shareId: string;
  path?: string;
  title?: string;
  content: string;
  assets?: PublicAssetPayload[];
}

interface PublicAssetPayload {
  assetId: string;
  originalPath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  url: string;
}

interface ShareCfSettings {
  workerUrl: string;
  vaultId?: string;
  clientToken?: string;
  sharedNotes: Record<string, SharedNoteRecord>;
  importedNotes: Record<string, string>;
  syncIntervalMinutes: number;
}

const DEFAULT_SETTINGS: ShareCfSettings = {
  workerUrl: "https://obsidian-share-cf.bigt.workers.dev",
  sharedNotes: {},
  importedNotes: {},
  syncIntervalMinutes: 30
};

const TOKEN_HEADER = "Authorization";

export default class ShareCfPlugin extends Plugin {
  settings: ShareCfSettings;
  private dirtyPaths = new Set<string>();
  private syncInFlight = false;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("share-2", "Share current note", () => {
      this.shareActiveNote();
    });

    this.addCommand({
      id: "share-current-note",
      name: "Share current note",
      callback: () => this.shareActiveNote()
    });

    this.addCommand({
      id: "sync-shared-notes",
      name: "Sync shared notes now",
      callback: () => this.syncAll(true)
    });

    this.registerObsidianProtocolHandler("sharecf", (params) => {
      this.importSharedNote(params);
    });
    this.registerObsidianProtocolHandler("share-cf", (params) => {
      this.importSharedNote(params);
    });

    this.addSettingTab(new ShareCfSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultModify(file)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDelete(file)));
    });

    this.registerInterval(
      window.setInterval(
        () => this.syncDirtyNotes(false),
        Math.max(1, this.settings.syncIntervalMinutes) * 60 * 1000
      )
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.workerUrl = normalizeWorkerUrl(this.settings.workerUrl || DEFAULT_SETTINGS.workerUrl);
    this.settings.sharedNotes = this.settings.sharedNotes ?? {};
    this.settings.importedNotes = this.settings.importedNotes ?? {};
    this.settings.syncIntervalMinutes = this.settings.syncIntervalMinutes || 30;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async shareActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Open a Markdown note before sharing.");
      return;
    }

    try {
      const record = await this.uploadNote(file, true);
      await this.copyToClipboard(record.url);
      new Notice(`Share link copied: ${record.url}`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not share note.");
      console.error("Share CF: share failed", error);
    }
  }

  markDirty(path: string) {
    if (this.settings.sharedNotes[path]) {
      this.dirtyPaths.add(path);
    }
  }

  async syncDirtyNotes(showNotice: boolean) {
    if (this.syncInFlight) {
      if (showNotice) new Notice("Share CF sync is already running.");
      return;
    }

    if (!this.settings.workerUrl) {
      if (showNotice) new Notice("Set your Cloudflare Worker URL first.");
      return;
    }

    const paths = Array.from(this.dirtyPaths);
    if (paths.length === 0) {
      if (showNotice) new Notice("No shared note changes to sync.");
      return;
    }

    this.syncInFlight = true;
    let synced = 0;

    try {
      for (const path of paths) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
          this.dirtyPaths.delete(path);
          continue;
        }

        await this.uploadNote(file, false);
        this.dirtyPaths.delete(path);
        synced += 1;
      }

      if (showNotice) new Notice(`Synced ${synced} shared note${synced === 1 ? "" : "s"}.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Share CF sync failed.");
      console.error("Share CF: sync failed", error);
    } finally {
      this.syncInFlight = false;
    }
  }

  async syncAll(showNotice: boolean) {
    await this.syncDirtyNotes(showNotice);
    await this.syncImportedNotes(showNotice);
  }

  async unshare(path: string) {
    const record = this.settings.sharedNotes[path];
    if (!record) return;

    await this.ensureRegistered();
    await this.apiRequest(`/api/notes/${encodeURIComponent(record.noteId)}`, "DELETE");
    delete this.settings.sharedNotes[path];
    this.dirtyPaths.delete(path);
    await this.saveSettings();
    new Notice("Share link disabled.");
  }

  private async uploadNote(file: TFile, forceCreate: boolean): Promise<SharedNoteRecord> {
    await this.ensureRegistered();

    let record = this.settings.sharedNotes[file.path];
    if (!record) {
      record = {
        noteId: crypto.randomUUID(),
        shareId: "",
        url: "",
        path: file.path,
        title: this.titleForFile(file)
      };
    }

    const originalContent = await this.app.vault.cachedRead(file);
    const prepared = await this.prepareUpload(file, originalContent, record.assets ?? {});

    if (!forceCreate && record.lastSyncedHash === prepared.contentHash) {
      return record;
    }

    const response = await this.apiRequest("/api/notes", "POST", {
      noteId: record.noteId,
      path: file.path,
      title: this.titleForFile(file),
      content: prepared.content,
      contentHash: prepared.contentHash,
      assets: prepared.assets,
      updatedAt: new Date(file.stat.mtime).toISOString()
    });

    const payload = response.json as { noteId: string; shareId: string; url: string };
    const updatedRecord: SharedNoteRecord = {
      ...record,
      noteId: payload.noteId,
      shareId: payload.shareId,
      url: payload.url,
      path: file.path,
      title: this.titleForFile(file),
      assets: prepared.assetRecords,
      lastSyncedHash: prepared.contentHash,
      lastSyncedAt: Date.now()
    };

    this.settings.sharedNotes[file.path] = updatedRecord;
    await this.saveSettings();
    return updatedRecord;
  }

  private async ensureRegistered() {
    if (!this.settings.workerUrl) {
      throw new Error("Set your Cloudflare Worker URL in Share CF settings first.");
    }

    if (this.settings.vaultId && this.settings.clientToken) {
      return;
    }

    const response = await requestUrl({
      url: `${normalizeWorkerUrl(this.settings.workerUrl)}/api/register`,
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        clientName: this.app.vault.getName(),
        clientVersion: this.manifest.version
      })
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Worker registration failed with HTTP ${response.status}.`);
    }

    const payload = response.json as { vaultId: string; clientToken: string };
    this.settings.vaultId = payload.vaultId;
    this.settings.clientToken = payload.clientToken;
    await this.saveSettings();
  }

  private async apiRequest(path: string, method: string, body?: unknown) {
    if (!this.settings.clientToken) {
      throw new Error("Share CF is not registered with the Worker.");
    }

    const response = await requestUrl({
      url: `${normalizeWorkerUrl(this.settings.workerUrl)}${path}`,
      method,
      headers: {
        "Content-Type": "application/json",
        [TOKEN_HEADER]: `Bearer ${this.settings.clientToken}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (response.status < 200 || response.status >= 300) {
      const message = response.text || `Worker request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }

    return response;
  }

  private async prepareUpload(file: TFile, content: string, previousAssets: Record<string, SharedAssetRecord>): Promise<PreparedUpload> {
    const assets: UploadAsset[] = [];
    const assetRecords: Record<string, SharedAssetRecord> = {};
    let rewritten = content;
    const replacements = await this.collectImageReplacements(file, content, previousAssets);

    for (const replacement of replacements) {
      rewritten = rewritten.split(replacement.originalReference).join(replacement.rewrittenReference);
      assets.push(replacement.asset);
      assetRecords[replacement.asset.originalPath] = {
        assetId: replacement.asset.assetId,
        contentHash: replacement.asset.contentHash,
        fileName: replacement.asset.fileName
      };
    }

    const assetHashInput = assets
      .map((asset) => `${asset.originalPath}:${asset.assetId}:${asset.contentHash}`)
      .sort()
      .join("|");

    return {
      content: rewritten,
      contentHash: await sha256Hex(`${rewritten}\n${assetHashInput}`),
      assets,
      assetRecords
    };
  }

  private async collectImageReplacements(file: TFile, content: string, previousAssets: Record<string, SharedAssetRecord>) {
    const replacements: Array<{ originalReference: string; rewrittenReference: string; asset: UploadAsset }> = [];
    const seen = new Set<string>();
    const matches = [
      ...findWikiImageMatches(content),
      ...findMarkdownImageMatches(content)
    ];

    for (const match of matches) {
      if (seen.has(match.originalReference)) continue;
      seen.add(match.originalReference);

      const assetFile = this.resolveLinkedFile(file, match.target);
      if (!assetFile || !isImageFile(assetFile)) continue;

      const data = await this.app.vault.readBinary(assetFile);
      const contentHash = await sha256ArrayBuffer(data);
      const previous = previousAssets[assetFile.path];
      const extension = extensionForPath(assetFile.path);
      const assetId = previous?.contentHash === contentHash
        ? previous.assetId
        : `${crypto.randomUUID()}${extension}`;
      const fileName = assetId;
      const contentType = contentTypeForPath(assetFile.path);

      replacements.push({
        originalReference: match.originalReference,
        rewrittenReference: match.toReference(`share-cf-asset://${assetId}`),
        asset: {
          assetId,
          originalPath: assetFile.path,
          fileName,
          contentType,
          contentHash,
          sizeBytes: data.byteLength,
          dataBase64: arrayBufferToBase64(data)
        }
      });
    }

    return replacements;
  }

  private resolveLinkedFile(note: TFile, target: string): TFile | null {
    const cleanTarget = target
      .split("#", 1)[0]
      .split("|", 1)[0]
      .trim()
      .replace(/^<(.+)>$/, "$1");
    if (!cleanTarget || /^[a-z][a-z0-9+.-]*:/i.test(cleanTarget)) return null;

    const direct = this.app.metadataCache.getFirstLinkpathDest(cleanTarget, note.path);
    if (direct instanceof TFile) return direct;

    const parent = note.parent?.path && note.parent.path !== "/" ? note.parent.path : "";
    const relativePath = normalizeVaultPath(parent ? `${parent}/${cleanTarget}` : cleanTarget);
    const relative = this.app.vault.getAbstractFileByPath(relativePath);
    return relative instanceof TFile ? relative : null;
  }

  async importSharedNote(params: ObsidianProtocolData) {
    if (params.mode !== "import") return;

    const shareId = asString(params.shareId);
    const workerUrl = normalizeWorkerUrl(asString(params.workerUrl) || this.settings.workerUrl);
    if (!shareId || !workerUrl) {
      new Notice("Share CF import link is missing note details.");
      return;
    }

    try {
      const response = await requestUrl({
        url: `${workerUrl}/api/public/notes/${encodeURIComponent(shareId)}`,
        method: "GET"
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(response.text || `Import failed with HTTP ${response.status}.`);
      }

      const payload = response.json as PublicNotePayload;

      const existingPath = this.settings.importedNotes[shareId];
      const existingFile = existingPath ? this.app.vault.getAbstractFileByPath(existingPath) : null;
      let destinationPath = existingFile instanceof TFile
        ? existingFile.path
        : await this.uniqueImportPath(payload.path, payload.title);
      const assetFolder = `Imported Shared Notes/_assets/${shareId}`;
      let importedContent = payload.content;

      for (const asset of payload.assets ?? []) {
        const assetPath = `${assetFolder}/${sanitizeFileName(asset.fileName || asset.assetId)}`;
        await this.ensureParentFolder(assetPath);
        const assetResponse = await requestUrl({
          url: `${workerUrl}${asset.url}`,
          method: "GET"
        });
        if (assetResponse.status < 200 || assetResponse.status >= 300) {
          throw new Error(assetResponse.text || `Image import failed with HTTP ${assetResponse.status}.`);
        }

        const existingAsset = this.app.vault.getAbstractFileByPath(assetPath);
        if (existingAsset instanceof TFile) {
          await this.app.vault.modifyBinary(existingAsset, assetResponse.arrayBuffer);
        } else {
          await this.app.vault.createBinary(assetPath, assetResponse.arrayBuffer);
        }

        const localReference = encodeURI(relativePathBetween(destinationPath, assetPath));
        importedContent = importedContent
          .split(asset.url)
          .join(localReference)
          .split(`${workerUrl}${asset.url}`)
          .join(localReference);
      }

      await this.ensureParentFolder(destinationPath);
      const file = this.app.vault.getAbstractFileByPath(destinationPath);

      if (file instanceof TFile) {
        await this.app.vault.modify(file, importedContent);
      } else {
        await this.app.vault.create(destinationPath, importedContent);
      }

      this.settings.importedNotes[shareId] = destinationPath;
      await this.saveSettings();
      await this.app.workspace.openLinkText(destinationPath, "", false);
      new Notice(`Pulled shared note into ${destinationPath}.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not pull shared note.");
      console.error("Share CF: import failed", error);
    }
  }

  async syncImportedNotes(showNotice: boolean) {
    const entries = Object.entries(this.settings.importedNotes);
    if (entries.length === 0) {
      if (showNotice) new Notice("No imported shared notes to pull.");
      return;
    }

    let pulled = 0;
    let removed = 0;
    for (const [shareId, path] of entries) {
      if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
        delete this.settings.importedNotes[shareId];
        removed += 1;
        continue;
      }

      await this.importSharedNote({
        action: "sharecf",
        mode: "import",
        shareId,
        workerUrl: this.settings.workerUrl
      });
      pulled += 1;
    }

    if (removed > 0) {
      await this.saveSettings();
    }

    if (showNotice) {
      const pulledText = `Pulled ${pulled} imported shared note${pulled === 1 ? "" : "s"}.`;
      const removedText = removed > 0 ? ` Removed ${removed} missing entr${removed === 1 ? "y" : "ies"}.` : "";
      new Notice(`${pulledText}${removedText}`);
    }
  }

  async untrackImportedNote(shareId: string) {
    const path = this.settings.importedNotes[shareId];
    if (!path) return;

    delete this.settings.importedNotes[shareId];
    await this.saveSettings();
    new Notice(`Stopped syncing ${path}.`);
  }

  private async uniqueImportPath(originalPath?: string, title?: string): Promise<string> {
    const basePath = `Imported Shared Notes/${sanitizeMarkdownPath(originalPath, title)}`;
    if (!this.app.vault.getAbstractFileByPath(basePath)) {
      return basePath;
    }

    const extension = basePath.toLowerCase().endsWith(".md") ? ".md" : "";
    const stem = extension ? basePath.slice(0, -extension.length) : basePath;
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${stem} ${index}${extension}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }

    return `Imported Shared Notes/${crypto.randomUUID()}.md`;
  }

  private async ensureParentFolder(path: string) {
    const parts = path.split("/").slice(0, -1);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`Cannot create folder because ${current} already exists.`);
      await this.app.vault.createFolder(current);
    }
  }

  private onVaultModify(file: TAbstractFile) {
    if (file instanceof TFile && file.extension === "md") {
      this.markDirty(file.path);
    }
  }

  private async onVaultRename(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile) || file.extension !== "md") return;

    const record = this.settings.sharedNotes[oldPath];
    if (!record) return;

    delete this.settings.sharedNotes[oldPath];
    this.settings.sharedNotes[file.path] = {
      ...record,
      path: file.path,
      title: this.titleForFile(file)
    };
    this.dirtyPaths.delete(oldPath);
    this.dirtyPaths.add(file.path);
    await this.saveSettings();
  }

  private async onVaultDelete(file: TAbstractFile) {
    const record = this.settings.sharedNotes[file.path];
    let changed = false;

    if (record) {
      this.dirtyPaths.delete(file.path);
      delete this.settings.sharedNotes[file.path];
      changed = true;
    }

    for (const [shareId, path] of Object.entries(this.settings.importedNotes)) {
      if (path === file.path) {
        delete this.settings.importedNotes[shareId];
        changed = true;
      }
    }

    if (changed) {
      await this.saveSettings();
    }
  }

  private titleForFile(file: TFile) {
    return file.basename || file.name;
  }

  private async copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      new ShareLinkModal(this.app, text).open();
    }
  }
}

class ShareCfSettingTab extends PluginSettingTab {
  plugin: ShareCfPlugin;

  constructor(app: App, plugin: ShareCfPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Share CF" });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("The Cloudflare Worker URL used for sharing. You can replace the default with your own Worker.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.workerUrl)
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (value) => {
            this.plugin.settings.workerUrl = normalizeWorkerUrl(value || DEFAULT_SETTINGS.workerUrl);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("How often shared notes with local changes are pushed to Cloudflare.")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              this.plugin.settings.syncIntervalMinutes = parsed;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Vault registration")
      .setDesc(this.plugin.settings.vaultId ? `Registered as ${this.plugin.settings.vaultId}` : "Registers automatically the first time you share.")
      .addButton((button) =>
        button
          .setButtonText("Reset")
          .onClick(async () => {
            this.plugin.settings.vaultId = undefined;
            this.plugin.settings.clientToken = undefined;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Push queued local share changes and pull updates for imported shared notes.")
      .addButton((button) =>
        button
          .setButtonText("Sync")
          .setCta()
          .onClick(() => this.plugin.syncAll(true))
      );

    this.renderSharedNotes(containerEl);
    this.renderImportedNotes(containerEl);
  }

  private renderSharedNotes(containerEl: HTMLElement) {
    containerEl.find(".share-cf-shared-notes")?.remove();
    const section = containerEl.createDiv({ cls: "share-cf-shared-notes" });
    section.createEl("h3", { text: "Shared notes" });
    const list = section.createDiv({ cls: "share-cf-note-list" });
    const records = Object.values(this.plugin.settings.sharedNotes);

    if (records.length === 0) {
      list.createDiv({ cls: "share-cf-status", text: "No shared notes yet." });
      return;
    }

    for (const record of records.sort((a, b) => a.path.localeCompare(b.path))) {
      const row = list.createDiv({ cls: "share-cf-note-row" });
      row.createDiv({ cls: "share-cf-note-path", text: record.path });
      new Setting(row)
        .addButton((button) =>
          button
            .setIcon("copy")
            .setTooltip("Copy share link")
            .onClick(async () => {
              await navigator.clipboard.writeText(record.url);
              new Notice("Share link copied.");
            })
        )
        .addButton((button) =>
          button
            .setIcon("trash")
            .setTooltip("Disable share link")
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.unshare(record.path);
                this.renderSharedNotes(containerEl);
              } catch (error) {
                button.setDisabled(false);
                new Notice(error instanceof Error ? error.message : "Could not disable share link.");
                console.error("Share CF: unshare failed", error);
              }
            })
        );
    }
  }

  private renderImportedNotes(containerEl: HTMLElement) {
    containerEl.find(".share-cf-imported-notes")?.remove();
    const section = containerEl.createDiv({ cls: "share-cf-imported-notes" });
    section.createEl("h3", { text: "Pulled documents" });
    const list = section.createDiv({ cls: "share-cf-note-list" });
    let pruned = false;
    const records = Object.entries(this.plugin.settings.importedNotes).filter(([shareId, path]) => {
      if (this.plugin.app.vault.getAbstractFileByPath(path) instanceof TFile) return true;
      delete this.plugin.settings.importedNotes[shareId];
      pruned = true;
      return false;
    });
    if (pruned) {
      this.plugin.saveSettings();
    }

    if (records.length === 0) {
      list.createDiv({ cls: "share-cf-status", text: "No pulled documents yet." });
      return;
    }

    for (const [shareId, path] of records.sort((a, b) => a[1].localeCompare(b[1]))) {
      const row = list.createDiv({ cls: "share-cf-note-row" });
      row.createDiv({ cls: "share-cf-note-path", text: path });
      new Setting(row)
        .addButton((button) =>
          button
            .setIcon("refresh-cw")
            .setTooltip("Pull latest server copy")
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.importSharedNote({
                  action: "sharecf",
                  mode: "import",
                  shareId,
                  workerUrl: this.plugin.settings.workerUrl
                });
                this.renderImportedNotes(containerEl);
              } catch (error) {
                button.setDisabled(false);
                new Notice(error instanceof Error ? error.message : "Could not pull imported note.");
                console.error("Share CF: pull imported note failed", error);
              }
            })
        )
        .addButton((button) =>
          button
            .setIcon("x")
            .setTooltip("Stop syncing this pulled document")
            .onClick(async () => {
              await this.plugin.untrackImportedNote(shareId);
              this.renderImportedNotes(containerEl);
            })
        );
    }
  }
}

class ShareLinkModal extends Modal {
  constructor(app: App, private readonly url: string) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Share link" });
    contentEl.createEl("p", { text: "Copy this link:" });
    contentEl.createEl("input", { value: this.url, attr: { readonly: "true" } });
  }
}

function normalizeWorkerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function asString(value: string | "true" | undefined): string {
  return typeof value === "string" && value !== "true" ? value : "";
}

function sanitizeMarkdownPath(originalPath?: string, title?: string): string {
  const source = originalPath || `${title || "Shared note"}.md`;
  const parts = source
    .split(/[\\/]+/)
    .map((part) => part.trim().replace(/[<>:"|?*#^[\]]/g, "-"))
    .filter((part) => part && part !== "." && part !== "..");

  const safeParts = parts.length > 0 ? parts : ["Shared note.md"];
  const lastIndex = safeParts.length - 1;
  if (!safeParts[lastIndex].toLowerCase().endsWith(".md")) {
    safeParts[lastIndex] = `${safeParts[lastIndex]}.md`;
  }

  return safeParts.join("/");
}

function findWikiImageMatches(content: string): ImageReferenceMatch[] {
  const matches: ImageReferenceMatch[] = [];
  const regex = /!\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const originalReference = match[0];
    const target = match[1];
    matches.push({
      originalReference,
      target,
      toReference: (url) => `![](${url})`
    });
  }
  return matches;
}

function findMarkdownImageMatches(content: string): ImageReferenceMatch[] {
  const matches: ImageReferenceMatch[] = [];
  const regex = /!\[([^\]]*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const originalReference = match[0];
    const alt = match[1];
    const rawTarget = match[2].trim();
    const target = rawTarget.replace(/\s+"[^"]*"$/, "");
    matches.push({
      originalReference,
      target,
      toReference: (url) => `![${alt}](${url})`
    });
  }
  return matches;
}

function isImageFile(file: TFile): boolean {
  return /\.(apng|avif|gif|jpe?g|png|svg|webp)$/i.test(file.path);
}

function extensionForPath(path: string): string {
  const match = path.match(/\.([a-z0-9]+)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".bin";
}

function contentTypeForPath(path: string): string {
  const extension = extensionForPath(path);
  switch (extension) {
    case ".apng":
      return "image/apng";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function sha256ArrayBuffer(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeVaultPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function sanitizeFileName(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*#^[\]]/g, "-") || `${crypto.randomUUID()}.bin`;
}

function relativePathBetween(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split("/").slice(0, -1);
  const toParts = toFile.split("/");

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const prefix = fromParts.map(() => "..");
  return [...prefix, ...toParts].join("/") || toFile;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
