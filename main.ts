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
  lastSyncedHash?: string;
  lastSyncedAt?: number;
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
      callback: () => this.syncDirtyNotes(true)
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

    const content = await this.app.vault.cachedRead(file);
    const contentHash = await sha256Hex(content);

    if (!forceCreate && record.lastSyncedHash === contentHash) {
      return record;
    }

    const response = await this.apiRequest("/api/notes", "POST", {
      noteId: record.noteId,
      path: file.path,
      title: this.titleForFile(file),
      content,
      contentHash,
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
      lastSyncedHash: contentHash,
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

  private async importSharedNote(params: ObsidianProtocolData) {
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

      const payload = response.json as {
        shareId: string;
        path?: string;
        title?: string;
        content: string;
      };

      const existingPath = this.settings.importedNotes[shareId];
      const existingFile = existingPath ? this.app.vault.getAbstractFileByPath(existingPath) : null;
      let destinationPath = existingFile instanceof TFile
        ? existingFile.path
        : await this.uniqueImportPath(payload.path, payload.title);

      await this.ensureParentFolder(destinationPath);
      const file = this.app.vault.getAbstractFileByPath(destinationPath);

      if (file instanceof TFile) {
        await this.app.vault.modify(file, payload.content);
      } else {
        await this.app.vault.create(destinationPath, payload.content);
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
    if (!record) return;

    this.dirtyPaths.delete(file.path);
    delete this.settings.sharedNotes[file.path];
    await this.saveSettings();
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
      .setDesc("Push all queued changes for notes that are already shared.")
      .addButton((button) =>
        button
          .setButtonText("Sync")
          .setCta()
          .onClick(() => this.plugin.syncDirtyNotes(true))
      );

    this.renderSharedNotes(containerEl);
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
