import { $RefParser } from '@apidevtools/json-schema-ref-parser';
import { indexResources, normalizeAnchors, OpenApiPreparation, type ReferenceTarget, type SchemaResource } from './prepare';

export type ReadVaultFile = (path: string) => Promise<string>;

const ORIGIN = 'https://openapi-vault.invalid';
const PREFIX = '/__vault__/';

function fileUrl(path: string): string {
  return `${ORIGIN}${PREFIX}${path.split('/').map(encodeURIComponent).join('/')}`;
}

function vaultPath(url: string): string {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || !parsed.pathname.startsWith(PREFIX) || parsed.search) {
    throw new Error(`Only relative references to files inside this vault are supported: ${url}`);
  }
  const path = decodeURIComponent(parsed.pathname.slice(PREFIX.length));
  if (!path || path.split('/').some(part => part === '..' || part === '.') || path.includes('\\')) {
    throw new Error(`Reference points outside the vault: ${url}`);
  }
  return path;
}

function assertOpenApi(spec: unknown): asserts spec is Record<string, any> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('Select an OpenAPI 3.0 or 3.1 YAML/JSON document.');
  }
  const doc = spec as Record<string, unknown>;
  if (typeof doc.openapi !== 'string' || !/^3\.(0|1)\.\d+(?:[-+].*)?$/.test(doc.openapi)) {
    throw new Error('Select an OpenAPI 3.0 or 3.1 YAML/JSON document.');
  }
  const info = doc.info as Record<string, unknown> | undefined;
  if (!info || typeof info.title !== 'string' || typeof info.version !== 'string') {
    throw new Error('The OpenAPI document must include info.title and info.version.');
  }
}

export async function bundleOpenApi(
  path: string,
  read: ReadVaultFile,
  dependencies = new Set<string>(),
): Promise<{ spec: Record<string, any>; dependencies: Set<string> }> {
  const url = fileUrl(path);
  const parser = new $RefParser();
  const preparation = new OpenApiPreparation();
  const resources = new Map<string, SchemaResource>();
  const documents = new Map<string, Promise<unknown>>();
  const prepared = new Map<string, unknown>();
  let indexedRevision = -1;
  let sourceError: unknown;
  function loadRaw(documentUrl: string): Promise<unknown> {
    const existing = documents.get(documentUrl);
    if (existing) return existing;
    const pending = (async () => {
      const resolved = vaultPath(documentUrl);
      dependencies.add(resolved);
      const raw = await new $RefParser().parse(documentUrl, {
        resolve: {
          file: false, http: false,
          vault: { canRead: true, read: async () => {
            try { return await read(resolved); }
            catch (error) { sourceError ??= error; throw error; }
          } },
        },
      });
      // Contexts may still arrive through transitive refs. Validate only after discovery.
      indexResources(preparation.resourceDocument(raw, documentUrl), documentUrl, resources, false);
      return raw;
    })();
    documents.set(documentUrl, pending);
    return pending;
  }
  async function resolveTarget(reference: string): Promise<ReferenceTarget> {
    if (indexedRevision !== preparation.contextRevision) {
      // Previously indexed identities can become ignored siblings as schema
      // contexts arrive. Never resolve the next ref against those stale aliases.
      resources.clear();
      for (const [documentUrl, pending] of documents) {
        indexResources(preparation.resourceDocument(await pending, documentUrl), documentUrl, resources, false);
      }
      indexedRevision = preparation.contextRevision;
    }
    const target = new URL(reference);
    const fragment = decodeURIComponent(target.hash.slice(1));
    target.hash = '';
    if (!resources.has(target.href)) await loadRaw(target.href);
    const resource = resources.get(target.href)!;
    const pointer = fragment && !fragment.startsWith('/')
      ? resource.anchors.get(fragment)
      : `${resource.pointer}${fragment}`;
    if (pointer === undefined) throw new Error(`Schema anchor not found: ${reference}`);
    let value: any = await loadRaw(resource.documentUrl);
    let base = resource.documentUrl;
    for (const part of pointer ? pointer.slice(1).split('/') : []) {
      if (value && typeof value.$id === 'string') base = new URL(value.$id, base).href;
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error(`JSON Pointer target not found: ${reference}`);
      }
      value = value[key];
    }
    return { value, base, location: `${resource.documentUrl}${pointer ? `#${pointer}` : ''}` };
  }
  async function load(documentUrl: string): Promise<unknown> {
    if (prepared.has(documentUrl)) return prepared.get(documentUrl);
    // Discovery loads every reachable file before the generic bundler starts.
    throw new Error(`Reference was not discovered: ${documentUrl}`);
  }
  const options = {
    resolve: {
      file: false as const,
      http: false as const,
      vault: {
        order: 1,
        canRead: true,
        read: async (file: { url: string }) => {
          try {
            const document = await load(file.url);
            await normalizeAnchors(document, file.url, resources, load);
            return document as Record<string, any>;
          } catch (error) {
            sourceError ??= error;
            throw error;
          }
        },
      },
    },
  };
  try {
    const raw = await loadRaw(url);
    assertOpenApi(raw);
    await preparation.discover(raw, url, resolveTarget);
    // The generic parser resolves all structural refs in each loaded file, not
    // just the selected target. Finish discovering those branches before freezing.
    let previousSize: number;
    let previousRevision: number;
    do {
      previousSize = documents.size;
      previousRevision = preparation.contextRevision;
      for (const [documentUrl, pending] of documents) {
        await preparation.discover(await pending as Record<string, any>, documentUrl, resolveTarget);
      }
    } while (documents.size !== previousSize || preparation.contextRevision !== previousRevision);
    resources.clear();
    for (const [documentUrl, pending] of documents) {
      const document = preparation.prepare(await pending, documentUrl);
      prepared.set(documentUrl, document);
      indexResources(document, documentUrl, resources);
    }
    const parsed = await parser.parse(url, options);
    assertOpenApi(parsed);
    const bundled = await parser.bundle(url, parsed, options);
    preparation.finalize(bundled, url);
    const spec = preparation.restore(bundled);
    assertOpenApi(spec);
    return { spec, dependencies };
  } catch (error) {
    // $Ref Parser wraps custom-resolver errors with a generic "Error reading file".
    // Preserve the underlying YAML diagnostic or missing-file message for the user.
    throw sourceError ?? error;
  }
}
