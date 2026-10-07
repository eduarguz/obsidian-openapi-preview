import { FuzzySuggestModal, Notice, Plugin, TFile } from 'obsidian';
import { OpenApiView, VIEW_TYPE_OPENAPI } from './view';

export function isSpecificationFile(file: TFile): boolean {
  return ['yaml', 'yml', 'json'].includes(file.extension.toLowerCase());
}

class SpecificationPicker extends FuzzySuggestModal<TFile> {
  constructor(private readonly plugin: OpenApiPlugin) {
    super(plugin.app);
    this.setPlaceholder('Choose an OpenAPI YAML or JSON file');
  }

  override getItems(): TFile[] {
    return this.app.vault.getFiles().filter(isSpecificationFile).sort((a, b) => a.path.localeCompare(b.path));
  }

  override getItemText(file: TFile): string {
    return file.path;
  }

  override onChooseItem(file: TFile): void {
    void this.plugin.openPreview(file);
  }
}

export default class OpenApiPlugin extends Plugin {
  override onload(): void {
    this.registerView(VIEW_TYPE_OPENAPI, leaf => new OpenApiView(leaf));

    const unavailable: string[] = [];
    for (const extension of ['yaml', 'yml', 'json']) {
      try {
        this.registerExtensions([extension], VIEW_TYPE_OPENAPI);
      } catch (error) {
        // Another handler must not prevent the rest of this plugin from loading.
        unavailable.push(`.${extension}`);
        console.warn(`OpenAPI Preview could not register .${extension}`, error);
      }
    }
    if (unavailable.length) {
      new Notice(`OpenAPI Preview could not register ${unavailable.join(', ')}. You can still use the Open OpenAPI preview command.`);
    }

    this.addCommand({
      id: 'open-openapi-preview',
      name: 'Open OpenAPI preview',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file && isSpecificationFile(file)) void this.openPreview(file);
        else new SpecificationPicker(this).open();
      },
    });

    this.addCommand({
      id: 'choose-openapi-file',
      name: 'Choose OpenAPI file',
      callback: () => new SpecificationPicker(this).open(),
    });

    this.addCommand({
      id: 'refresh-openapi-preview',
      name: 'Refresh OpenAPI preview',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(OpenApiView);
        if (!view) return false;
        if (!checking) view.scheduleRefresh();
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !isSpecificationFile(file)) return;
      menu.addItem(item => item
        .setTitle('Open OpenAPI preview')
        .setIcon('book-open')
        .onClick(() => { void this.openPreview(file); }));
    }));
  }

  async openPreview(file: TFile): Promise<void> {
    try {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_OPENAPI)
        .find(leaf => leaf.getViewState().state?.file === file.path);
      const leaf = existing ?? this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_OPENAPI, state: { file: file.path }, active: true });
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      new Notice(`Could not open OpenAPI preview: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
