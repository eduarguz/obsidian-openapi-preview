import { describe, expect, it } from 'vitest';
import { bundleOpenApi } from '../src/bundle';
import { readFile } from 'node:fs/promises';

const root = (version = '3.1.0') => `openapi: ${version}\ninfo:\n  title: Example API\n  version: 1.0.0\npaths: {}\n`;

function vault(files: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (path: string) => {
      reads.push(path);
      if (!(path in files)) throw new Error(`File not found in vault: ${path}`);
      return files[path]!;
    },
  };
}

describe('vault OpenAPI bundling', () => {
  it.each(['3.0.3', '3.1.0'])('loads a self-contained OpenAPI %s document', async version => {
    const source = vault({ 'api.yaml': root(version) });
    const result = await bundleOpenApi('api.yaml', source.read);
    expect(result.spec.openapi).toBe(version);
    expect([...result.dependencies]).toEqual(['api.yaml']);
  });

  it('resolves nested relative YAML and JSON refs with fragments and spaces', async () => {
    const source = vault({
      'APIs/open api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: ./schemas/user%20schema.yaml\n',
      'APIs/schemas/user schema.yaml': 'type: object\nproperties:\n  address:\n    $ref: ../../shared/address.json#/Address\n',
      'shared/address.json': JSON.stringify({ Address: { type: 'string', description: 'A postal address' } }),
    });
    const result = await bundleOpenApi('APIs/open api.yaml', source.read);
    expect(result.spec.components.schemas.User.properties.address.description).toBe('A postal address');
    expect([...result.dependencies].sort()).toEqual(Object.keys({
      'APIs/open api.yaml': '', 'APIs/schemas/user schema.yaml': '', 'shared/address.json': '',
    }).sort());
  });

  it('preserves recursive schemas as serializable internal references', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Node:\n      $ref: ./node.yaml\n',
      'node.yaml': 'type: object\nproperties:\n  child:\n    $ref: ./node.yaml\n',
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Node.properties.child.$ref).toMatch(/^#/);
    expect(() => JSON.stringify(spec)).not.toThrow();
  });

  it('reports missing files and records them so creating the file can refresh the view', async () => {
    const source = vault({ 'api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: ./missing.yaml\n' });
    const dependencies = new Set<string>();
    await expect(bundleOpenApi('api.yaml', source.read, dependencies)).rejects.toThrow(/missing.yaml/);
    expect(dependencies.has('missing.yaml')).toBe(true);
  });

  it('rejects an ordinary YAML document', async () => {
    await expect(bundleOpenApi('config.yaml', vault({ 'config.yaml': 'name: config' }).read))
      .rejects.toThrow(/OpenAPI 3\.0 or 3\.1/);
  });

  it('reports malformed YAML', async () => {
    await expect(bundleOpenApi('api.yaml', vault({ 'api.yaml': 'openapi: [broken' }).read))
      .rejects.toThrow(/parsing/i);
  });

  it('rejects unresolved JSON Pointer fragments', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: ./user.json#/Missing\n',
      'user.json': '{"User":{"type":"object"}}',
    });
    await expect(bundleOpenApi('api.yaml', source.read)).rejects.toThrow(/Missing/);
  });

  it('does not read remote references', async () => {
    const source = vault({ 'api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: https://example.com/user.yaml\n' });
    await expect(bundleOpenApi('api.yaml', source.read)).rejects.toThrow();
    expect(source.reads).toEqual(['api.yaml']);
  });

  it('does not read paths outside the vault', async () => {
    const source = vault({ 'api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: ../outside.yaml\n' });
    await expect(bundleOpenApi('api.yaml', source.read)).rejects.toThrow();
    expect(source.reads).toEqual(['api.yaml']);
  });

  it('bundles the shipped example with reusable and recursive schema references', async () => {
    const { spec, dependencies } = await bundleOpenApi('examples/openapi.yaml', path => readFile(path, 'utf8'));
    expect(dependencies.size).toBe(3);
    expect(spec.paths['/users'].get.summary).toBe('List users');
    expect(() => JSON.stringify(spec)).not.toThrow();
  });

  it('bundles refs inside schema siblings of a 3.1 $ref without losing constraints', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: ./base.json\n      properties:\n        child:\n          $ref: ./child.json\n',
      'base.json': '{"type":"object","required":["id"]}',
      'child.json': '{"type":"string","minLength":2}',
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(JSON.stringify(spec)).not.toContain('./child.json');
    expect(JSON.stringify(spec)).toContain('minLength');
    expect(JSON.stringify(spec)).toContain('required');
  });

  it('preserves literal refs in examples and defaults, including referenced example files', async () => {
    const source = vault({
      'api.json': JSON.stringify({
        openapi: '3.1.0', info: { title: 'Examples', version: '1' }, paths: {},
        components: {
          examples: { Inline: { value: { $ref: 'literal', $id: 'also-literal' } }, External: { $ref: './example.json' } },
          schemas: { Data: { type: 'object', default: { $ref: 'literal-default' }, properties: { example: { $ref: './child.json' } } } },
        },
      }),
      'example.json': '{"value":{"$ref":"literal-external"}}',
      'child.json': '{"type":"string"}',
    });
    const { spec } = await bundleOpenApi('api.json', source.read);
    expect(spec.components.examples.Inline.value).toEqual({ $ref: 'literal', $id: 'also-literal' });
    expect(spec.components.examples.External.value.$ref).toBe('literal-external');
    expect(spec.components.schemas.Data.default.$ref).toBe('literal-default');
    expect(spec.components.schemas.Data.properties.example.type).toBe('string');
  });

  it('resolves file-local named anchors in external schemas', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    User:\n      $ref: ./user.json#user\n',
      'user.json': '{"$defs":{"User":{"$anchor":"user","type":"string"}}}',
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.User.type).toBe('string');
  });

  it('keeps $id-scoped anchors inside the offline bundle', async () => {
    const source = vault({ 'api.json': JSON.stringify({
      openapi: '3.1.0', info: { title: 'Scoped anchors', version: '1' }, paths: {},
      components: { schemas: { A: { $id: './resources/a', $defs: { Node: { $anchor: 'node', type: 'string' } }, properties: { child: { $ref: '#node' } } } } },
    }) });
    const { spec } = await bundleOpenApi('api.json', source.read);
    expect(spec.components.schemas.A.properties.child.$ref).toMatch(/^#/);
    expect(JSON.stringify(spec)).not.toContain('https://openapi-vault.invalid');
  });

  it('resolves structurally named reusable parameters rather than masking their names', async () => {
    const source = vault({
      'api.json': JSON.stringify({ openapi: '3.1.0', info: { title: 'Maps', version: '1' }, paths: {}, components: { parameters: { default: { $ref: './param.json' } } } }),
      'param.json': '{"name":"limit","in":"query","schema":{"type":"integer"}}',
    });
    const { spec, dependencies } = await bundleOpenApi('api.json', source.read);
    expect(dependencies.has('param.json')).toBe(true);
    expect(JSON.stringify(spec)).not.toContain('./param.json');
  });

  it('preserves the intersection of constraints in an external schema ref sibling', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./text.json\n',
      'text.json': '{"$ref":"./base.json","maxLength":10}',
      'base.json': '{"type":"string","maxLength":5}',
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(JSON.stringify(spec)).toContain('"maxLength":5');
    expect(JSON.stringify(spec)).toContain('"maxLength":10');
  });

  it('ignores OpenAPI 3.0 schema Reference Object siblings', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    Text:\n      $ref: ./base.json\n      properties:\n        unused:\n          $ref: ./missing.json\n',
      'base.json': '{"type":"string"}',
    });
    const { spec, dependencies } = await bundleOpenApi('api.yaml', source.read);
    expect(dependencies.has('missing.json')).toBe(false);
    expect(JSON.stringify(spec)).not.toContain('unused');
  });

  it('preserves intersecting OpenAPI 3.1 constraints at an external JSON Pointer target', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./schemas.json#/Text\n',
      'schemas.json': JSON.stringify({ Text: { $ref: './base.json', maxLength: 10 } }),
      'base.json': JSON.stringify({ type: 'string', maxLength: 5 }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toMatchObject({
      maxLength: 10,
      allOf: expect.arrayContaining([{ type: 'string', maxLength: 5 }]),
    });
  });

  it('ignores OpenAPI 3.0 schema ref siblings at an external JSON Pointer target', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    Text:\n      $ref: ./schemas.json#/Text\n',
      'schemas.json': JSON.stringify({ Text: { $ref: './base.json', properties: { unused: { $ref: './missing.json' } } } }),
      'base.json': JSON.stringify({ type: 'string' }),
    });
    const { spec, dependencies } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toEqual({ type: 'string' });
    expect(dependencies.has('missing.json')).toBe(false);
    expect(source.reads).not.toContain('missing.json');
  });

  it('preserves literal refs in schema examples at an external JSON Pointer target', async () => {
    const examples = [{ $ref: 'literal-example', $id: 'literal-id' }];
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Data:\n      $ref: ./schemas.json#/Data\n',
      'schemas.json': JSON.stringify({ Data: { type: 'object', examples } }),
    });
    const { spec, dependencies } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Data.examples).toEqual(examples);
    expect(source.reads).toEqual(['api.yaml', 'schemas.json']);
    expect([...dependencies].sort()).toEqual(['api.yaml', 'schemas.json']);
  });

  it.each(['paths', 'components'])('preserves literal refs in %s specification extensions', async location => {
    const extension = { $ref: 'literal', nested: { $ref: 'nested-literal' } };
    const source = vault({
      'api.json': JSON.stringify({
        openapi: '3.1.0', info: { title: 'Extensions', version: '1' }, paths: {},
        [location]: { 'x-metadata': extension },
      }),
    });
    const { spec, dependencies } = await bundleOpenApi('api.json', source.read);
    expect(spec[location]['x-metadata']).toEqual(extension);
    expect(source.reads).toEqual(['api.json']);
    expect([...dependencies]).toEqual(['api.json']);
  });

  it.each(['paths', 'components'])('preserves literal IDs in %s specification extensions', async location => {
    const extension = { $id: 'literal-id', nested: { $id: 'nested-literal-id' } };
    const source = vault({
      'api.json': JSON.stringify({
        openapi: '3.1.0', info: { title: 'Extensions', version: '1' }, paths: {},
        [location]: { 'x-metadata': extension },
      }),
    });
    const { spec } = await bundleOpenApi('api.json', source.read);
    expect(spec[location]['x-metadata']).toEqual(extension);
  });

  it('resolves schema properties whose names start with x-', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Data:\n      type: object\n      properties:\n        x-value:\n          $ref: ./value.json\n',
      'value.json': JSON.stringify({ type: 'string' }),
    });
    const { spec, dependencies } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Data.properties['x-value']).toEqual({ type: 'string' });
    expect(dependencies.has('value.json')).toBe(true);
  });

  it.each([true, false])('preserves constraints through file-local ref chains (target first: %s)', async targetFirst => {
    const Base = { $ref: './base.json', maxLength: 10 };
    const Text = { $ref: '#/Base' };
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./schemas.json#/Text\n',
      'schemas.json': JSON.stringify(targetFirst ? { Base, Text } : { Text, Base }),
      'base.json': JSON.stringify({ type: 'string', maxLength: 5 }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toMatchObject({
      maxLength: 10, allOf: expect.arrayContaining([{ type: 'string', maxLength: 5 }]),
    });
  });

  it('ignores OpenAPI 3.0 siblings through a file-local ref chain', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    Text:\n      $ref: ./schemas.json#/Text\n',
      'schemas.json': JSON.stringify({
        Base: { $ref: './base.json', properties: { unused: { $ref: './missing.json' } } },
        Text: { $ref: '#/Base' },
      }),
      'base.json': JSON.stringify({ type: 'string' }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toEqual({ type: 'string' });
    expect(source.reads).not.toContain('missing.json');
  });

  it('preserves literal examples through a file-local ref chain', async () => {
    const examples = [{ $ref: 'literal', $id: 'literal-id' }];
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./schemas.json#/Text\n',
      'schemas.json': JSON.stringify({ Base: { type: 'object', examples }, Text: { $ref: '#/Base' } }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text.examples).toEqual(examples);
    expect(source.reads).toEqual(['api.yaml', 'schemas.json']);
  });

  it('does not index schema identities inside literal example payloads during discovery', async () => {
    const examples = [{ $anchor: 'duplicate' }, { $anchor: 'duplicate', nested: { $id: './literal' } }];
    const source = vault({
      'api.json': JSON.stringify({
        openapi: '3.1.0', info: { title: 'Literal identities', version: '1' }, paths: {},
        components: { schemas: { Data: { type: 'object', examples } } },
      }),
    });
    const { spec } = await bundleOpenApi('api.json', source.read);
    expect(spec.components.schemas.Data.examples).toEqual(examples);
  });

  it('keeps the root dialect when an external catalog has an openapi entry', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./catalog.json#/Text\n',
      'catalog.json': JSON.stringify({ openapi: { type: 'string' }, Text: { $ref: './base.json', maxLength: 10 } }),
      'base.json': JSON.stringify({ type: 'string', maxLength: 20 }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toMatchObject({
      maxLength: 10, allOf: expect.arrayContaining([{ type: 'string', maxLength: 20 }]),
    });
  });

  it('discovers files referenced by other entries in a loaded catalog', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./catalog.json#/Text\n',
      'catalog.json': JSON.stringify({ Text: { type: 'string' }, Unused: { $ref: './unused.json' } }),
      'unused.json': JSON.stringify({ type: 'integer' }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toEqual({ type: 'string' });
  });

  it.each([true, false])('ignores duplicate anchors in transitive 3.0 siblings (catalog first: %s)', async catalogFirst => {
    const First = { $ref: './catalog.json#/First' };
    const Text = { $ref: './text.json' };
    const source = vault({
      'api.json': JSON.stringify({ openapi: '3.0.3', info: { title: 'Ignored anchors', version: '1' }, paths: {},
        components: { schemas: catalogFirst ? { First, Text } : { Text, First } } }),
      'catalog.json': JSON.stringify({ First: { type: 'integer' }, Base: { $ref: './base.json',
        properties: { a: { $anchor: 'duplicate' }, b: { $anchor: 'duplicate' } } } }),
      'text.json': JSON.stringify({ $ref: './catalog.json#/Base' }),
      'base.json': JSON.stringify({ type: 'string' }),
    });
    const { spec } = await bundleOpenApi('api.json', source.read);
    expect(spec.components.schemas.Text).toEqual({ type: 'string' });
  });

  it('ignores $id siblings when resolving an OpenAPI 3.0 schema ref', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    Text:\n      $ref: ./catalog.json#/Text\n',
      'catalog.json': JSON.stringify({ Text: { $ref: './base.json', $id: './wrong/' } }),
      'base.json': JSON.stringify({ type: 'string' }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toEqual({ type: 'string' });
    expect(source.reads).not.toContain('wrong/base.json');
  });

  it('invalidates provisional aliases from newly ignored OpenAPI 3.0 $id siblings', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    First:\n      $ref: ./catalog.json#/First\n    Text:\n      $ref: ./text.json\n    Other:\n      $ref: ./real.json\n',
      'catalog.json': JSON.stringify({ First: { type: 'integer' }, Base: { $ref: './base.json', $id: './real.json' } }),
      'text.json': JSON.stringify({ $ref: './catalog.json#/Base' }),
      'base.json': JSON.stringify({ type: 'string' }),
      'real.json': JSON.stringify({ type: 'boolean' }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Other).toEqual({ type: 'boolean' });
    expect(source.reads).toContain('real.json');
  });

  it('recognizes standalone schema examples reached through other catalog entries', async () => {
    const examples = [{ $ref: 'literal' }];
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    First:\n      $ref: ./catalog.json#/First\n',
      'catalog.json': JSON.stringify({ First: { type: 'string' }, Unused: { $ref: './unused.json' } }),
      'unused.json': JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', examples }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.First).toEqual({ type: 'string' });
    expect(source.reads).not.toContain('literal');
  });

  it('ignores standalone 3.0 schema siblings reached through other catalog entries', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    First:\n      $ref: ./catalog.json#/First\n',
      'catalog.json': JSON.stringify({ First: { type: 'string' }, Unused: { $ref: './unused.json' } }),
      'unused.json': JSON.stringify({ $ref: './base.json', properties: { ignored: { $ref: './missing.json' } } }),
      'base.json': JSON.stringify({ type: 'string' }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.First).toEqual({ type: 'string' });
    expect(source.reads).not.toContain('missing.json');
  });

  it.each(['x-Text', 'example', 'default'])('prepares a known schema pointer target named %s in an external catalog', async key => {
    const source = vault({
      'api.yaml': root() + `components:\n  schemas:\n    Text:\n      $ref: ./catalog.json#/${key}\n`,
      'catalog.json': JSON.stringify({ [key]: { $ref: './base.json', maxLength: 10 } }),
      'base.json': JSON.stringify({ type: 'string', maxLength: 5 }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toMatchObject({
      maxLength: 10, allOf: expect.arrayContaining([{ type: 'string', maxLength: 5 }]),
    });
    expect(JSON.stringify(spec)).not.toContain('./base.json');
  });

  it('ignores a standalone OpenAPI 3.0 not sibling reached through a catalog', async () => {
    const source = vault({
      'api.yaml': root('3.0.3') + 'components:\n  schemas:\n    First:\n      $ref: ./catalog.json#/First\n',
      'catalog.json': JSON.stringify({ First: { type: 'string' }, Unused: { $ref: './unused.json' } }),
      'unused.json': JSON.stringify({ $ref: './base.json', not: { $ref: './missing.json' } }),
      'base.json': JSON.stringify({ type: 'string' }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.First).toEqual({ type: 'string' });
    expect(source.reads).not.toContain('missing.json');
  });

  it.each(['type', 'items', 'const'])('preserves a known special-name target in a catalog with an entry named %s', async catalogKey => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./catalog.json#/x-Text\n',
      'catalog.json': JSON.stringify({ [catalogKey]: { type: 'integer' }, 'x-Text': { $ref: './base.json', maxLength: 10 } }),
      'base.json': JSON.stringify({ type: 'string', maxLength: 5 }),
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(spec.components.schemas.Text).toMatchObject({
      maxLength: 10, allOf: expect.arrayContaining([{ type: 'string', maxLength: 5 }]),
    });
    expect(JSON.stringify(spec)).not.toContain('./base.json');
  });

  it.each([true, false])('discovers schema context in shared catalogs regardless of load order (catalog first: %s)', async catalogFirst => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    First:\n      $ref: ./catalog.json#/First\n    Text:\n      $ref: ./text.json\n',
      'catalog.json': JSON.stringify({ First: { type: 'integer' }, Base: { $ref: './base.json', maxLength: 10 } }),
      'text.json': JSON.stringify({ $ref: './catalog.json#/Base' }),
      'base.json': JSON.stringify({ type: 'string', maxLength: 5 }),
    });
    const { spec } = await bundleOpenApi('api.yaml', async path => {
      if (path === (catalogFirst ? 'text.json' : 'catalog.json')) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return source.read(path);
    });
    // The generic bundler may retain an internal ref when a target is reused.
    const text = spec.components.schemas.Text;
    const resolved = text.$ref
      ? text.$ref.slice(2).split('/').map((part: string) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
        .reduce((value: any, key: string) => value[key], spec)
      : text;
    expect(resolved).toMatchObject({
      maxLength: 10, allOf: expect.arrayContaining([{ type: 'string', maxLength: 5 }]),
    });
  });

  it('escapes literal percent sequences in anchored JSON Pointer names', async () => {
    const source = vault({
      'api.yaml': root() + 'components:\n  schemas:\n    Text:\n      $ref: ./text.json#thing\n',
      'text.json': '{"$defs":{"A%20B":{"$anchor":"thing","type":"string"}}}',
    });
    const { spec } = await bundleOpenApi('api.yaml', source.read);
    expect(JSON.stringify(spec)).toContain('"type":"string"');
  });

  it('keeps external Path Items out of schema $ref sibling normalization', async () => {
    const source = vault({
      'api.json': JSON.stringify({ openapi: '3.1.0', info: { title: 'Path refs', version: '1' }, paths: { '/users': { $ref: './path.json' } } }),
      'path.json': '{"$ref":"./base-path.json","get":{"summary":"List users","responses":{"200":{"description":"OK"}}}}',
      'base-path.json': '{"description":"User operations"}',
    });
    const { spec } = await bundleOpenApi('api.json', source.read);
    expect(spec.paths['/users'].get.summary).toBe('List users');
    expect(spec.paths['/users'].allOf).toBeUndefined();
  });
});
