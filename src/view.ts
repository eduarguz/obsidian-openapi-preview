import { FileView, parseYaml, TFile, WorkspaceLeaf } from 'obsidian';
import { bundleOpenApi } from './bundle';
import { renderRedoc, type RenderedRedoc } from './renderer';

export const VIEW_TYPE_OPENAPI = 'openapi-preview';

export class OpenApiView extends FileView {
  private dependencies = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private closed = false;
  private rendered: RenderedRedoc | undefined;
  private renderController: AbortController | undefined;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
  }

  override getViewType(): string {
    return VIEW_TYPE_OPENAPI;
  }

  override getDisplayText(): string {
    return this.file ? `${this.file.basename} — OpenAPI` : 'OpenAPI preview';
  }

  override getIcon(): string {
    return 'book-open';
  }

  override canAcceptExtension(extension: string): boolean {
    return ['yaml', 'yml', 'json'].includes(extension.toLowerCase());
  }

  override async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass('openapi-preview');
    this.registerEvent(this.app.vault.on('modify', file => this.onDependencyChange(file.path)));
    this.registerEvent(this.app.vault.on('create', file => this.onDependencyChange(file.path)));
    this.registerEvent(this.app.vault.on('delete', file => this.onDependencyChange(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      // Folder moves can affect both the source file and relative dependency paths.
      const affected = [...this.dependencies].some(path =>
        path === oldPath || path.startsWith(`${oldPath}/`) ||
        path === file.path || path.startsWith(`${file.path}/`));
      if (affected) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.workspace.on('css-change', () => this.scheduleRefresh()));
    this.addAction('refresh-cw', 'Refresh OpenAPI preview', () => this.scheduleRefresh());
    this.showMessage('OpenAPI preview', 'Choose a YAML or JSON specification using the command palette.');
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await this.refresh(file);
  }

  override async onUnloadFile(_file: TFile): Promise<void> {
    this.invalidate();
    this.dependencies.clear();
    this.destroyRenderer();
  }

  override async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.scheduleRefresh();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.invalidate();
    this.destroyRenderer();
  }

  scheduleRefresh(): void {
    if (this.closed) return;
    // Invalidate immediately so an in-flight read cannot overwrite a newer change.
    this.invalidate();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.file && !this.closed) void this.refresh(this.file);
    }, 250);
  }

  private onDependencyChange(path: string): void {
    if (this.dependencies.has(path)) this.scheduleRefresh();
  }

  private invalidate(): void {
    this.generation++;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private destroyRenderer(): void {
    this.renderController?.abort();
    this.renderController = undefined;
    this.rendered?.destroy();
    this.rendered = undefined;
  }

  private showMessage(title: string, message: string): void {
    this.destroyRenderer();
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: 'openapi-preview-message' });
    box.createEl('h3', { text: title });
    box.createEl('pre', { text: message });
  }

  private showSource(source: string, diagnostic?: string): void {
    this.destroyRenderer();
    this.contentEl.empty();
    const box = this.contentEl.createDiv({ cls: 'openapi-preview-message openapi-preview-source' });
    box.createEl('h3', { text: 'Source (read-only)' });
    box.createEl('p', { text: diagnostic ?? 'This file is a schema fragment or another YAML/JSON document, rather than a complete OpenAPI specification.' });
    box.createEl('pre', { text: source });
  }

  private async refresh(file: TFile): Promise<void> {
    const generation = ++this.generation;
    const dependencies = new Set<string>([file.path]);
    this.dependencies = dependencies;
    const isCurrent = () => !this.closed && generation === this.generation;
    this.showMessage('Loading OpenAPI documentation…', file.path);
    try {
      const source = await this.app.vault.read(file);
      if (!isCurrent()) return;
      let document: unknown;
      try {
        document = file.extension.toLowerCase() === 'json' ? JSON.parse(source) : parseYaml(source);
      } catch (error) {
        this.showSource(source, `Could not parse this file: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!document || typeof document !== 'object' || Array.isArray(document) ||
        !Object.prototype.hasOwnProperty.call(document, 'openapi')) {
        this.showSource(source);
        return;
      }
      const result = await bundleOpenApi(file.path, async path => {
        if (path === file.path) return source;
        const dependency = this.app.vault.getAbstractFileByPath(path);
        if (!(dependency instanceof TFile)) throw new Error(`File not found in vault: ${path}`);
        return this.app.vault.read(dependency);
      }, dependencies);
      if (!isCurrent()) return;
      this.contentEl.empty();
      this.renderController = new AbortController();
      const rendered = await renderRedoc(this.contentEl, result.spec, file.path, this.renderController.signal);
      if (!isCurrent()) {
        rendered.destroy();
      } else {
        this.rendered = rendered;
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.showMessage('Could not render OpenAPI documentation', error instanceof Error ? error.message : String(error));
    }
  }
}
