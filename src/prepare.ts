type Context = 'document' | 'schema' | 'schema-map' | 'example-map' | 'example' | 'object-map' | 'paths-map' | 'components';
type JsonObject = Record<string, any>;

export interface ReferenceTarget {
  value: unknown;
  location: string;
  base: string;
}

const schemaMaps = new Set(['schemas', 'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const schemaChildren = new Set(['schema', 'items', 'prefixItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'allOf', 'oneOf', 'anyOf']);
const objectMaps = new Set(['paths', 'webhooks', 'content', 'responses', 'headers', 'callbacks', 'encoding']);

/** Adapt OpenAPI instance data and Schema $ref siblings to a generic JSON-reference bundler. */
export class OpenApiPreparation {
  private readonly marker = `__openapi_viewer_literal_${Math.random().toString(36).slice(2)}`;
  private readonly literals: unknown[] = [];
  private version31 = true;
  private versionKnown = false;
  private readonly referenceContexts = new Map<string, Context>();
  contextRevision = 0;

  private recordContext(location: string, context: Context): void {
    const previous = this.referenceContexts.get(location);
    if (previous === context || previous === 'schema') return;
    this.referenceContexts.set(location, context);
    this.contextRevision++;
  }

  private schemaRoot(value: any): boolean {
    return value && typeof value === 'object' &&
      ['type', 'properties', '$defs', '$schema', '$id', '$anchor', 'allOf', 'oneOf', 'anyOf', 'items', 'enum', 'const',
        'not', 'if', 'then', 'else', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems',
        'patternProperties', 'dependentSchemas', 'prefixItems', 'propertyNames', 'definitions',
        'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
        'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'required']
        .some(key => key in value);
  }

  private rootContext(document: unknown, documentUrl: string): Context {
    const known = this.referenceContexts.get(documentUrl);
    if (known === 'schema' || this.schemaRoot(document)) return 'schema';
    if (known) return known;
    const value = document as any;
    return value && typeof value === 'object' && '$ref' in value && Object.keys(value).some(key =>
      !['$ref', 'summary', 'description'].includes(key) && !key.startsWith('x-')) ? 'schema' : 'document';
  }

  /** Exclude instance payloads from the preliminary resource/anchor index. */
  resourceDocument(document: unknown, documentUrl: string): unknown {
    if (!this.versionKnown && document && typeof document === 'object' && 'openapi' in document) {
      this.version31 = String(document.openapi).startsWith('3.1.');
      this.versionKnown = true;
    }
    const seen = new Map<object, any>();
    const visit = (value: any, context: Context, location: string): any => {
      if (!value || typeof value !== 'object') return value;
      if (seen.has(value)) return seen.get(value);
      context = this.referenceContexts.get(location) ?? context;
      const result: any = Array.isArray(value) ? [] : {};
      seen.set(value, result);
      for (const key of Object.keys(value)) {
        // Schema examples are arrays even when their containing catalog target
        // has not yet been reached by context discovery; OpenAPI example maps aren't.
        if (this.isLiteral(key, context, location) || (key === 'examples' && Array.isArray(value[key]) && context === 'document')) continue;
        if (context === 'schema' && !this.version31 && typeof value.$ref === 'string' && key !== '$ref') continue;
        result[key] = visit(value[key], Array.isArray(value) ? context : this.childContext(key, context), this.childLocation(location, key));
      }
      return result;
    };
    return visit(document, this.rootContext(document, documentUrl), documentUrl);
  }

  /** Discover reachable target contexts before any document is destructively prepared. */
  async discover(document: JsonObject, documentUrl: string, resolve: (url: string) => Promise<ReferenceTarget>): Promise<void> {
    if (!this.versionKnown) {
      this.version31 = String(document.openapi).startsWith('3.1.');
      this.versionKnown = true;
    }
    const seen = new Map<object, Set<Context>>();
    const visit = async (value: any, context: Context, base: string, location: string): Promise<void> => {
      if (!value || typeof value !== 'object') return;
      context = this.referenceContexts.get(location) ?? context;
      const contexts = seen.get(value) ?? new Set<Context>();
      if (contexts.has(context)) return;
      contexts.add(context);
      seen.set(value, contexts);
      const ignoredSiblings = context === 'schema' && !this.version31 && typeof value.$ref === 'string';
      if (!ignoredSiblings && typeof value.$id === 'string') base = new URL(value.$id, base).href;
      if (typeof value.$ref === 'string') {
        const reference = new URL(value.$ref, base);
        const fragment = decodeURIComponent(reference.hash.slice(1));
        const documentUrl = reference.href.split('#')[0]!;
        // Make direct physical pointer contexts available while indexing a new file.
        this.recordContext(`${documentUrl}${fragment ? `#${fragment}` : ''}`, context);
        const target = await resolve(reference.href);
        const targetContext = context === 'document' && !target.location.includes('#') && this.schemaRoot(target.value)
          ? 'schema' : context;
        this.recordContext(target.location, targetContext);
        await visit(target.value, targetContext, target.base, target.location);
        if (ignoredSiblings) return;
      }
      for (const key of Object.keys(value)) {
        if (this.isLiteral(key, context, location)) continue;
        await visit(value[key], Array.isArray(value) ? context : this.childContext(key, context), base, this.childLocation(location, key));
      }
    };
    await visit(document, this.rootContext(document, documentUrl), documentUrl, documentUrl);
  }

  private childLocation(location: string, key: string): string {
    return `${location}${location.includes('#') ? '' : '#'}/${pointerPart(key)}`;
  }

  private isLiteral(key: string, context: Context, location: string): boolean {
    const inferredRoot = context === 'schema' && !location.includes('#') && this.referenceContexts.get(location) !== 'schema';
    if ((context === 'document' || inferredRoot) && this.referenceContexts.get(this.childLocation(location, key)) === 'schema') return false;
    if (context === 'schema-map' || context === 'example-map' || context === 'object-map') return false;
    if (context === 'paths-map' || context === 'components') return key.startsWith('x-');
    return key.startsWith('x-') || ['example', 'default', 'enum', 'const'].includes(key) ||
      (key === 'value' && context !== 'schema') || (key === 'examples' && context === 'schema');
  }

  private childContext(key: string, context: Context): Context {
    if (context === 'schema-map') return 'schema';
    if (context === 'example-map') return 'example';
    if (context === 'object-map' || context === 'paths-map') return 'document';
    if (context === 'components') return key === 'schemas' ? 'schema-map'
      : key === 'examples' ? 'example-map' : 'object-map';
    return schemaMaps.has(key) ? 'schema-map'
      : schemaChildren.has(key) ? 'schema'
      : key === 'components' ? 'components'
      : key === 'paths' ? 'paths-map'
      : objectMaps.has(key) ? 'object-map'
      : key === 'examples' ? 'example-map' : 'document';
  }

  prepare(document: unknown, documentUrl: string): unknown {
    if (!this.versionKnown && document && typeof document === 'object' && 'openapi' in document) {
      this.version31 = String(document.openapi).startsWith('3.1.');
      this.versionKnown = true;
    }
    const context = this.rootContext(document, documentUrl);
    return this.visit(document, context, new Set(), documentUrl, documentUrl);
  }

  private literal(value: unknown): object {
    const index = this.literals.push(value) - 1;
    return { [this.marker]: index };
  }

  private visit(value: any, context: Context, seen: Set<object>, base: string, location: string): any {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    context = this.referenceContexts.get(location) ?? context;
    if (typeof value.$id === 'string') base = new URL(value.$id, base).href;
    if (Array.isArray(value)) {
      return value.map((item, index) => this.visit(item, context, seen, base, this.childLocation(location, String(index))));
    }
    if (context === 'schema' && typeof value.$ref === 'string' && !this.version31) {
      // OpenAPI 3.0 Schema Reference Objects ignore every sibling, including its refs.
      for (const key of Object.keys(value)) if (key !== '$ref') delete value[key];
      return value;
    }
    for (const key of Object.keys(value)) {
      if (this.isLiteral(key, context, location)) {
        // Preserve the entire payload; keys such as $ref or $id are data here.
        value[key] = this.literal(value[key]);
      } else {
        value[key] = this.visit(value[key], this.childContext(key, context), seen, base, this.childLocation(location, key));
      }
    }
    if (context === 'schema' && typeof value.$ref === 'string' && Object.keys(value).length > 1) {
      // In 3.1, siblings are additional schema constraints, not overrides of the target.
      // allOf keeps that intersection semantics and lets the bundler visit every sibling.
      const reference = value.$ref;
      delete value.$ref;
      value.allOf = [{ $ref: reference }, ...(Array.isArray(value.allOf) ? value.allOf : [])];
    }
    return value;
  }

  restore(value: any, seen = new Set<object>()): any {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    if (Object.prototype.hasOwnProperty.call(value, this.marker)) return this.literals[value[this.marker]];
    seen.add(value);
    for (const key of Object.keys(value)) value[key] = this.restore(value[key], seen);
    return value;
  }

  finalize(value: any, rootUrl: string, seen = new Set<object>()): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    // Instance payloads are still masked at this point, so schema identities can be
    // removed safely. All static refs now address the bundled root, not their old scopes.
    delete value.$id;
    if (typeof value.$ref === 'string') {
      if (value.$ref.startsWith(`${rootUrl}#`)) value.$ref = value.$ref.slice(rootUrl.length);
      if (!value.$ref.startsWith('#')) throw new Error(`Reference was not bundled: ${value.$ref}`);
    }
    for (const child of Object.values(value)) this.finalize(child, rootUrl, seen);
  }
}

export interface SchemaResource {
  documentUrl: string;
  pointer: string;
  anchors: Map<string, string>;
}

function pointerPart(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Index file-local anchors and embedded resources established by $id. */
export function indexResources(document: unknown, documentUrl: string, resources: Map<string, SchemaResource>, validate = true): void {
  const root: SchemaResource = { documentUrl, pointer: '', anchors: new Map() };
  resources.set(documentUrl, root);
  const seen = new Set<object>();
  function visit(value: any, pointer: string, base: string, resource: SchemaResource): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (typeof value.$id === 'string') {
      base = new URL(value.$id, base).href;
      if (pointer) resource = { documentUrl, pointer, anchors: new Map() };
      resources.set(base.split('#')[0]!, resource);
    }
    if (typeof value.$anchor === 'string') {
      if (validate && resource.anchors.has(value.$anchor)) throw new Error(`Duplicate schema anchor: ${value.$anchor}`);
      resource.anchors.set(value.$anchor, pointer);
    }
    for (const key of Object.keys(value)) visit(value[key], `${pointer}/${pointerPart(key)}`, base, resource);
  }
  visit(document, '', documentUrl, root);
}

/** Turn named anchors into file-based JSON Pointers before the generic bundler sees them. */
export async function normalizeAnchors(
  document: unknown,
  documentUrl: string,
  resources: Map<string, SchemaResource>,
  load: (url: string) => Promise<unknown>,
): Promise<void> {
  const seen = new Set<object>();
  async function visit(value: any, base: string): Promise<void> {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (typeof value.$id === 'string') base = new URL(value.$id, base).href;
    if (typeof value.$ref === 'string') {
      const target = new URL(value.$ref, base);
      const fragment = decodeURIComponent(target.hash.slice(1));
      if (fragment && !fragment.startsWith('/')) {
        target.hash = '';
        if (!resources.has(target.href)) await load(target.href);
        const resource = resources.get(target.href);
        const pointer = resource?.anchors.get(fragment);
        if (pointer === undefined) throw new Error(`Schema anchor not found: ${value.$ref}`);
        value.$ref = `${resource!.documentUrl}#${encodeURIComponent(pointer).replaceAll('%2F', '/')}`;
      } else {
        // Resolve regular pointers and file refs in their $id scope as well. The
        // pinned generic bundler can then operate on explicit physical file URIs.
        const uri = new URL(target.href);
        uri.hash = '';
        const resource = resources.get(uri.href);
        if (resource) {
          const pointer = `${resource.pointer}${fragment}`;
          value.$ref = `${resource.documentUrl}#${encodeURIComponent(pointer).replaceAll('%2F', '/')}`;
        } else {
          value.$ref = target.href;
        }
      }
    }
    // Sequential traversal also ensures anchors in earlier loaded resources are registered.
    for (const child of Object.values(value)) await visit(child, base);
  }
  await visit(document, documentUrl);
}
