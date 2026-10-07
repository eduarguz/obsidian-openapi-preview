/** Small host adapter: exercise the real view and renderer without launching Obsidian. */
import { load } from 'js-yaml';

export function parseYaml(source: string): unknown {
  return load(source);
}

export class TFile {
  constructor(public path: string) {}
  get basename(): string { return this.path.split('/').pop()!.replace(/\.[^.]+$/, ''); }
  get extension(): string { return this.path.split('.').pop() ?? ''; }
}

type Listener = (...args: any[]) => void;

class Events {
  private listeners = new Map<string, Listener[]>();
  on(name: string, callback: Listener): Listener {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
    return callback;
  }
  emit(name: string, ...args: any[]): void {
    for (const callback of this.listeners.get(name) ?? []) callback(...args);
  }
}

export class TestVault extends Events {
  files = new Map<string, { file: TFile; content: string }>();
  constructor(files: Record<string, string>) {
    super();
    for (const [path, content] of Object.entries(files)) this.files.set(path, { file: new TFile(path), content });
  }
  getAbstractFileByPath(path: string): TFile | null { return this.files.get(path)?.file ?? null; }
  async read(file: TFile): Promise<string> { return this.files.get(file.path)!.content; }
  update(path: string, content: string): void {
    const existing = this.files.get(path);
    const file = existing?.file ?? new TFile(path);
    this.files.set(path, { file, content });
    this.emit(existing ? 'modify' : 'create', file);
  }
  remove(path: string): void {
    const file = this.files.get(path)!.file;
    this.files.delete(path);
    this.emit('delete', file);
  }
}

export class FileView {
  app: any;
  file: TFile | null = null;
  contentEl: HTMLElement;
  navigation = true;
  constructor(leaf: any) {
    this.app = leaf.app;
    this.contentEl = document.createElement('div');
    this.contentEl.style.height = '800px';
    document.body.appendChild(this.contentEl);
    Object.assign(this.contentEl, {
      addClass: (name: string) => this.contentEl.classList.add(name),
      empty: () => this.contentEl.replaceChildren(),
      createDiv: ({ cls }: { cls: string }) => {
        const box = document.createElement('div');
        box.className = cls;
        Object.assign(box, {
          createEl: (tag: string, { text }: { text: string }) => {
            const el = document.createElement(tag);
            el.textContent = text;
            box.appendChild(el);
            return el;
          },
        });
        this.contentEl.appendChild(box);
        return box;
      },
    });
  }
  registerEvent(_event: unknown): void {}
  addAction(_icon: string, _title: string, _callback: Listener): void {}
  async onRename(_file: TFile): Promise<void> {}
}

export class Plugin {
  commands: any[] = [];
  constructor(public app: any) {}
  registerView(type: string, factory: unknown): void { this.app.views.set(type, factory); }
  registerExtensions(extensions: string[], type: string): void {
    for (const extension of extensions) {
      if (this.app.extensions.has(extension)) throw new Error(`Extension already registered: ${extension}`);
      this.app.extensions.set(extension, type);
    }
  }
  addCommand(command: any): void { this.commands.push(command); }
  registerEvent(_event: unknown): void {}
}

export class FuzzySuggestModal {
  constructor(public app: any) {}
  setPlaceholder(_placeholder: string): void {}
  open(): void {}
}

export class Notice {
  constructor(_message: string) {}
}

export function testApp(files: Record<string, string>): any {
  return { vault: new TestVault(files), workspace: new Events(), views: new Map(), extensions: new Map() };
}
