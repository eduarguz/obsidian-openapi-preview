import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
let source: string;

test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/browser/entry.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    alias: { obsidian: './tests/browser/obsidian.ts', path: 'path-browserify' },
    inject: ['src/buffer-shim.ts'],
    loader: { '.svg': 'text' },
    write: false,
    plugins: [{
      name: 'redoc-source',
      setup(build) {
        build.onResolve({ filter: /^redoc-standalone-source$/ }, () => ({
          path: require.resolve('redoc/bundles/redoc.standalone.js'), namespace: 'redoc-source',
        }));
        build.onLoad({ filter: /.*/, namespace: 'redoc-source' }, async ({ path }) => ({
          contents: await readFile(path, 'utf8'), loader: 'text',
        }));
      },
    }],
  });
  source = result.outputFiles[0]!.text;
});

test('renders a multi-file API offline, sanitizes descriptions, and cleans up the frame', async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="preview" style="height:800px; --background-primary: #ffffff; --text-normal: #222222"></div>');
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const win = window as any;
    const files: Record<string, string> = {
      'api/openapi.yaml': `openapi: 3.1.0
info:
  title: Vault Users API
  version: 1.0.0
  description: '<img src=x onerror="window.bad = true">'
paths:
  /users:
    $ref: ./paths/users.yaml
`,
      'api/paths/users.yaml': `get:
  summary: List users
  responses:
    '200':
      description: List of users
      content:
        application/json:
          schema:
            $ref: ../../schemas/user.json
`,
      'schemas/user.json': JSON.stringify({ $ref: './base.json', properties: { username: { type: 'string', description: 'Unique user name' } } }),
      'schemas/base.json': JSON.stringify({ type: 'object', properties: { id: { type: 'integer' } } }),
    };
    const { spec } = await win.bundleOpenApi('api/openapi.yaml', async (path: string) => {
      if (!(path in files)) throw new Error(path);
      return files[path];
    });
    win.preview = await win.renderRedoc(document.getElementById('preview'), spec, 'api/openapi.yaml');
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.getByText('Vault Users API', { exact: false }).first()).toBeVisible();
  await expect(frame.getByText('List users', { exact: true }).last()).toBeVisible();
  await expect(frame.locator('body')).toContainText('"username": "string"');
  expect(await page.locator('iframe').evaluate((element: HTMLIFrameElement) =>
    element.contentDocument!.querySelector('[onerror]') !== null)).toBe(false);
  // The malicious description's image can attempt a request; renderer assets/fonts must not.
  expect(requests.filter(url => !url.endsWith('/x') && url !== 'x')).toEqual([]);
  expect(errors).toEqual([]);
  await page.evaluate(() => (window as any).preview.destroy());
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('uses dark theme colors and renders in a narrow tab', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.setContent('<body class="theme-dark"><div id="preview" style="height:800px; --background-primary: #202020; --background-secondary: #181818; --text-normal: #eeeeee"></div></body>');
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const win = window as any;
    await win.renderRedoc(document.getElementById('preview'), {
      openapi: '3.0.3', info: { title: 'Dark API', version: '1.0.0' }, paths: {},
    }, 'dark.yaml');
  });
  const frame = page.frameLocator('iframe');
  await expect(frame.getByText('Dark API', { exact: false }).first()).toBeVisible();
  const background = await page.locator('iframe').evaluate((element: HTMLIFrameElement) =>
    element.contentWindow!.getComputedStyle(element.contentDocument!.body).backgroundColor);
  expect(background).toBe('rgb(32, 32, 32)');
});

test('renders with Obsidian calc-based accent colors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setContent('<div id="preview" style="height:800px; --text-accent: hsl(calc(258 - 3), calc(88% * 1.02), calc(66% * 1.15))"></div>');
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    const win = window as any;
    win.renderRedoc(document.getElementById('preview'), {
      openapi: '3.1.0', info: { title: 'Obsidian Accent API', version: '1' }, paths: {},
    }, 'accent.yaml').then((preview: unknown) => { win.preview = preview; });
  });
  await expect(page.frameLocator('iframe').getByText('Obsidian Accent API', { exact: false }).first()).toBeVisible();
  expect(errors).toEqual([]);
  await page.evaluate(() => (window as any).preview.destroy());
});

test('reuses a restored deferred tab by its persisted file path', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  const result = await page.evaluate(async () => {
    const win = window as any;
    const app = win.testApp({ 'api.yaml': '' });
    let created = 0;
    let revealed = false;
    const leaf = {
      view: {}, // A deferred Obsidian tab is not yet an OpenApiView instance.
      getViewState: () => ({ type: 'openapi-preview', state: { file: 'api.yaml' } }),
      setViewState: async () => {},
    };
    app.workspace.getLeavesOfType = () => [leaf];
    app.workspace.getLeaf = () => { created++; return leaf; };
    app.workspace.revealLeaf = async (value: object) => { revealed = value === leaf; };
    const plugin = new win.OpenApiPlugin(app);
    await plugin.openPreview(app.vault.getAbstractFileByPath('api.yaml'));
    return { created, revealed };
  });
  expect(result).toEqual({ created: 0, revealed: true });
});

test('cancels an obsolete render and removes its frame', async ({ page }) => {
  await page.setContent('<div id="preview"></div>');
  await page.addScriptTag({ content: source });
  const outcome = await page.evaluate(async () => {
    const win = window as any;
    const controller = new AbortController();
    const pending = win.renderRedoc(document.getElementById('preview'), {
      openapi: '3.0.3', info: { title: 'Cancelled API', version: '1.0.0' }, paths: {},
    }, 'cancel.yaml', controller.signal);
    controller.abort();
    return pending.then(() => 'rendered', () => 'aborted');
  });
  expect(outcome).toBe('aborted');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('recovers a missing dependency when its containing folder is renamed into place', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const win = window as any;
    win.app = win.testApp({
      'api.yaml': 'openapi: 3.1.0\ninfo: {title: Rename API, version: "1"}\npaths:\n  /users:\n    $ref: ./paths/users.yaml',
      'incoming/users.yaml': 'get:\n  summary: Renamed path\n  responses:\n    "200":\n      description: OK',
    });
    win.view = new win.OpenApiView({ app: win.app });
    await win.view.onOpen();
    win.view.file = win.app.vault.getAbstractFileByPath('api.yaml');
    await win.view.onLoadFile(win.view.file);
  });
  await expect(page.getByText('Could not render OpenAPI documentation')).toBeVisible();
  await page.evaluate(() => {
    const vault = (window as any).app.vault;
    const entry = vault.files.get('incoming/users.yaml');
    vault.files.delete('incoming/users.yaml');
    entry.file.path = 'paths/users.yaml';
    vault.files.set(entry.file.path, entry);
    vault.emit('rename', { path: 'paths' }, 'incoming');
  });
  await expect(page.frameLocator('iframe').getByText('Renamed path', { exact: true }).last()).toBeVisible();
});

test('refreshes dependencies and recovers when a missing file is created', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const win = window as any;
    win.app = win.testApp({
      'api.yaml': `openapi: 3.1.0
info: { title: Refresh API, version: 1.0.0 }
paths:
  /users:
    $ref: ./user.yaml
`,
    });
    win.view = new win.OpenApiView({ app: win.app });
    await win.view.onOpen();
    win.view.file = win.app.vault.getAbstractFileByPath('api.yaml');
    await win.view.onLoadFile(win.view.file);
  });
  await expect(page.getByText('Could not render OpenAPI documentation')).toBeVisible();
  await page.evaluate(() => (window as any).app.vault.update('user.yaml', 'get:\n  summary: First version\n  responses:\n    "200":\n      description: OK'));
  await expect(page.frameLocator('iframe').getByText('First version', { exact: true }).last()).toBeVisible();
  await page.evaluate(() => (window as any).app.vault.update('user.yaml', 'get:\n  summary: Updated version\n  responses:\n    "200":\n      description: OK'));
  await expect(page.frameLocator('iframe').getByText('Updated version', { exact: true }).last()).toBeVisible();
  await page.evaluate(() => (window as any).app.vault.remove('user.yaml'));
  await expect(page.getByText('Could not render OpenAPI documentation')).toBeVisible();
  await page.evaluate(() => (window as any).view.onClose());
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('recognizes YAML, YML and JSON through the registered default view', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  const registered = await page.evaluate(async () => {
    const win = window as any;
    const app = win.testApp({ 'spec.yaml': 'openapi: 3.1.0\ninfo: {title: Default View API, version: "1"}\npaths: {}' });
    const plugin = new win.OpenApiPlugin(app);
    plugin.onload();
    const type = app.extensions.get('yaml');
    if (type) {
      const view = app.views.get(type)({ app });
      await view.onOpen();
      view.file = app.vault.getAbstractFileByPath('spec.yaml');
      await view.onLoadFile(view.file);
    }
    return [...app.extensions.entries()];
  });
  expect(registered).toEqual([
    ['yaml', 'openapi-preview'], ['yml', 'openapi-preview'], ['json', 'openapi-preview'],
  ]);
  await expect(page.frameLocator('iframe').getByText('Default View API', { exact: false }).first()).toBeVisible();
});

test('preserves an existing extension handler and still loads commands and other file types', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  const result = await page.evaluate(() => {
    const win = window as any;
    const app = win.testApp({});
    app.extensions.set('yaml', 'another-plugin');
    const plugin = new win.OpenApiPlugin(app);
    plugin.onload();
    return { registered: [...app.extensions.entries()], commands: plugin.commands.map((command: any) => command.id) };
  });
  expect(result.registered).toEqual([
    ['yaml', 'another-plugin'], ['yml', 'openapi-preview'], ['json', 'openapi-preview'],
  ]);
  expect(result.commands).toContain('open-openapi-preview');
  expect(result.commands).toContain('choose-openapi-file');
});

for (const [filename, content] of [
  ['schema.yaml', 'type: object\nproperties:\n  name:\n    type: string\n'],
  ['config.yml', 'enabled: true\nlabel: plain configuration\n'],
  ['config.json', '{"label":"<img src=x onerror=alert(1)>","enabled":true}'],
  ['broken.yaml', 'openapi: [broken'],
]) {
  test(`shows ${filename} as literal read-only source`, async ({ page }) => {
    await page.setContent('<body></body>');
    await page.addScriptTag({ content: source });
    await page.evaluate(async ({ filename, content }) => {
      const win = window as any;
      const app = win.testApp({ [filename]: content });
      const view = new win.OpenApiView({ app });
      await view.onOpen();
      view.file = app.vault.getAbstractFileByPath(filename);
      await view.onLoadFile(view.file);
    }, { filename: filename!, content: content! });
    await expect(page.getByRole('heading', { name: 'Source (read-only)' })).toBeVisible();
    expect(await page.locator('.openapi-preview-source pre').textContent()).toBe(content);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.locator('img, textarea, [contenteditable="true"]')).toHaveCount(0);
    if (filename === 'broken.yaml') {
      await expect(page.getByText('Could not parse this file:', { exact: false })).toBeVisible();
    }
  });
}

test('keeps errors visible for documents declaring an invalid OpenAPI version', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const win = window as any;
    const app = win.testApp({ 'invalid.yaml': 'openapi: 9.0.0\ninfo: {title: Invalid, version: "1"}\npaths: {}' });
    const view = new win.OpenApiView({ app });
    await view.onOpen();
    view.file = app.vault.getAbstractFileByPath('invalid.yaml');
    await view.onLoadFile(view.file);
  });
  await expect(page.getByText('Could not render OpenAPI documentation')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Source (read-only)' })).toHaveCount(0);
});

test('automatically switches between source and API preview as the file changes', async ({ page }) => {
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: source });
  await page.evaluate(async () => {
    const win = window as any;
    win.app = win.testApp({ 'changing.yaml': 'type: string' });
    win.view = new win.OpenApiView({ app: win.app });
    await win.view.onOpen();
    win.view.file = win.app.vault.getAbstractFileByPath('changing.yaml');
    await win.view.onLoadFile(win.view.file);
  });
  await expect(page.getByRole('heading', { name: 'Source (read-only)' })).toBeVisible();
  await page.evaluate(() => (window as any).app.vault.update('changing.yaml',
    'openapi: 3.1.0\ninfo: {title: Changed API, version: "1"}\npaths: {}'));
  await expect(page.frameLocator('iframe').getByText('Changed API', { exact: false }).first()).toBeVisible();
  await page.evaluate(() => (window as any).app.vault.update('changing.yaml', 'type: integer'));
  await expect(page.getByRole('heading', { name: 'Source (read-only)' })).toBeVisible();
  await expect(page.locator('.openapi-preview-source pre')).toHaveText('type: integer');
  await expect(page.locator('iframe')).toHaveCount(0);
});
