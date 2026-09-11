/**
 * GitBook's published Markdown writes an API operation, and each schema on a models page, as a
 * fenced OpenAPI document holding just that operation or schema. Read as what it documents, an
 * operation becomes its parameters, request body and responses, and a schema its fields: source
 * components the GitBook mapping resolves to ParamField, ResponseField and Expandable, in the
 * shape Documentation.AI generates from a spec. Any other JSON fence stays code.
 */
import { nodeId } from '../session/ids.js';
import type { Block, ComponentNode, Inline } from './types.js';

// OpenAPI documents are untyped JSON; every access below is guarded by isObject.
type Json = Record<string, any>;

export interface OpenApiBlockContext {
  /** Namespaces the node ids. */
  file: string;
  /** Parses an authored description (Markdown) into blocks. */
  markdown: (text: string, key: string) => Block[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_DEPTH = 6;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The blocks an OpenAPI fence documents, or undefined when the fence is not a one-operation or one-schema OpenAPI document. */
export function gitbookOpenApiBlocks(source: string, ctx: OpenApiBlockContext): Block[] | undefined {
  let doc: unknown;
  try { doc = JSON.parse(source); } catch { return undefined; }
  if (!isObject(doc) || typeof doc.openapi !== 'string') return undefined;
  const reader = new SpecReader(doc, ctx);
  const paths = isObject(doc.paths) ? Object.entries(doc.paths) : [];
  const operations = paths.flatMap(([path, item]) => (isObject(item) ? METHODS.filter((method) => isObject(item[method])).map((method) => ({ path, method, operation: item[method] as Json, item })) : []));
  if (operations.length === 1) return reader.operation(operations[0]);
  const schemas = isObject(doc.components) && isObject(doc.components.schemas) ? Object.keys(doc.components.schemas) : [];
  // a models-page block lists the documented schema first, then the schemas it references
  if (!operations.length && schemas.length) return reader.schema(schemas[0]);
  return undefined;
}

class SpecReader {
  private count = 0;

  constructor(private readonly doc: Json, private readonly ctx: OpenApiBlockContext) {}

  operation({ path, method, operation, item }: { path: string; method: string; operation: Json; item: Json }): Block[] {
    const out: Block[] = [this.paragraph([this.strong(method.toUpperCase()), this.text(' '), this.code(path)])];

    const byKey = new Map<string, Json>();
    for (const value of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]) {
      const parameter = this.resolve(value);
      if (parameter && typeof parameter.name === 'string') byKey.set(`${parameter.in}:${parameter.name}`, parameter);
    }
    const parameters = [
      ...this.securityParams(operation.security ?? this.doc.security),
      ...[...byKey.values()].map((parameter) => {
        const schema = parameter.schema ?? (isObject(parameter.content) ? (Object.values(parameter.content)[0] as Json | undefined)?.schema : undefined);
        const location = parameter.in === 'cookie' ? 'header' : String(parameter.in ?? 'query');
        return this.param(location, parameter.name, schema, !!parameter.required || parameter.in === 'path', parameter.description, !!parameter.deprecated, 0);
      }),
    ];
    if (parameters.length) out.push(this.label('Parameters'), ...parameters);

    const body = this.resolve(operation.requestBody);
    const bodyMedia = body && isObject(body.content) ? (Object.values(body.content)[0] as Json | undefined) : undefined;
    if (body && bodyMedia) {
      const fields = this.bodyFields(bodyMedia.schema);
      out.push(this.label('Request body'));
      if (fields.length) out.push(...this.description(body.description, 'body'), ...fields);
      else out.push(this.param('body', 'body', bodyMedia.schema, !!body.required, body.description, false, 0));
    }

    const responses = isObject(operation.responses) ? Object.entries(operation.responses) : [];
    if (responses.length) {
      out.push(this.label('Responses'));
      for (const [status, value] of responses) {
        const response = this.resolve(value);
        const description = typeof response?.description === 'string' && response.description.trim() ? [this.text(` ${response.description.trim()}`)] : [];
        out.push(this.paragraph([this.code(status), ...description]));
        const media = response && isObject(response.content) ? (Object.values(response.content)[0] as Json | undefined) : undefined;
        if (media) out.push(...this.fieldsOf(media.schema));
      }
    }
    return out;
  }

  schema(name: string): Block[] {
    const schema = this.schemaOf({ $ref: `#/components/schemas/${name.replace(/~/g, '~0').replace(/\//g, '~1')}` });
    if (!schema) return [];
    const out = this.description(schema.description, `schema:${name}`);
    const fields = this.fieldsOf(schema);
    if (fields.length) {
      if (schema.type === 'array') out.push(this.paragraph([this.text('An array of '), this.code(this.refName(schema.items) ?? this.typeOf(this.schemaOf(schema.items))), this.text(' objects:')]));
      return [...out, ...fields];
    }
    const values = this.enumOf(schema);
    const allowed = values ? [this.text(', one of: '), ...values.flatMap((value, index) => [...(index ? [this.text(', ')] : []), this.code(value)])] : [];
    return [...out, this.paragraph([this.code(this.typeOf(schema)), ...allowed])];
  }

  /** A parameter or request-body field; an object (or array of objects) nests its properties in an Expandable. */
  private param(location: string, name: string, schemaValue: unknown, required: boolean, description: unknown, deprecated: boolean, depth: number): Block {
    const schema = this.schemaOf(schemaValue, depth);
    const props: ComponentNode['props'] = { [location]: name, 'param-type': this.typeOf(schema) };
    if (required) props.required = true;
    if (deprecated) props.deprecated = true;
    const values = this.enumOf(schema);
    if (values) props.enum = values.join(',');
    const text = typeof description === 'string' && description.trim() ? description : schema?.description;
    const nested = this.nested(schema, depth, (child, property, childRequired, childDepth) => this.param(location, child, property, childRequired, undefined, !!this.resolve(property)?.deprecated, childDepth));
    return this.component('api-param', props, [...this.description(text, `${location}:${name}`), ...nested]);
  }

  /** A response or schema field; an object (or array of objects) nests its properties in an Expandable. */
  private field(name: string, schemaValue: unknown, required: boolean, depth: number): Block {
    const schema = this.schemaOf(schemaValue, depth);
    const props: ComponentNode['props'] = { name, 'field-type': this.typeOf(schema) };
    if (required) props.required = true;
    if (schema?.deprecated) props.deprecated = true;
    const values = this.enumOf(schema);
    if (values) props.enum = values.join(',');
    const nested = this.nested(schema, depth, (child, property, childRequired, childDepth) => this.field(child, property, childRequired, childDepth));
    return this.component('api-field', props, [...this.description(schema?.description, `field:${name}`), ...nested]);
  }

  private bodyFields(schemaValue: unknown): Block[] {
    const target = this.objectTarget(this.schemaOf(schemaValue));
    if (!target) return [];
    const required = new Set<string>(Array.isArray(target.required) ? target.required : []);
    return Object.entries(target.properties as Json).map(([name, property]) => this.param('body', name, property, required.has(name), undefined, !!this.resolve(property)?.deprecated, 1));
  }

  private fieldsOf(schemaValue: unknown): Block[] {
    const target = this.objectTarget(this.schemaOf(schemaValue));
    if (!target) return [];
    const required = new Set<string>(Array.isArray(target.required) ? target.required : []);
    return Object.entries(target.properties as Json).map(([name, property]) => this.field(name, property, required.has(name), 1));
  }

  private nested(schema: Json | undefined, depth: number, child: (name: string, property: unknown, required: boolean, depth: number) => Block): Block[] {
    if (!schema || depth >= MAX_DEPTH) return [];
    const target = this.objectTarget(schema, depth);
    if (!target) return [];
    const required = new Set<string>(Array.isArray(target.required) ? target.required : []);
    const fields = Object.entries(target.properties as Json).map(([name, property]) => child(name, property, required.has(name), depth + 1));
    return [this.component('api-properties', { title: schema.type === 'array' ? 'Array Items' : 'Object Properties' }, fields)];
  }

  /** The object whose properties a schema documents: itself, or the items of an array of objects. */
  private objectTarget(schema: Json | undefined, depth = 0): Json | undefined {
    const target = schema?.type === 'array' ? this.schemaOf(schema.items, depth + 1) : schema;
    return target && isObject(target.properties) && Object.keys(target.properties).length ? target : undefined;
  }

  private securityParams(requirements: unknown): Block[] {
    if (!Array.isArray(requirements)) return [];
    const schemes = isObject(this.doc.components) && isObject(this.doc.components.securitySchemes) ? this.doc.components.securitySchemes : {};
    const seen = new Set<string>();
    const out: Block[] = [];
    for (const requirement of requirements) {
      if (!isObject(requirement)) continue;
      for (const key of Object.keys(requirement)) {
        const scheme = this.resolve(schemes[key]);
        if (!scheme) continue;
        const location = scheme.type === 'apiKey' && scheme.in === 'query' ? 'query' : 'header';
        const name = scheme.type === 'apiKey' ? String(scheme.name ?? key) : 'Authorization';
        if (seen.has(`${location}:${name}`)) continue;
        seen.add(`${location}:${name}`);
        // alternatives (more than one requirement) make no single scheme required
        out.push(this.param(location, name, { type: 'string' }, requirements.length === 1, scheme.description, false, 0));
      }
    }
    return out;
  }

  /** `#/…` references followed to the object they name; a cycle or an external reference resolves to nothing. */
  private resolve(value: unknown): Json | undefined {
    const seen = new Set<string>();
    let current = value;
    while (isObject(current) && typeof current.$ref === 'string') {
      const ref: string = current.$ref;
      if (seen.has(ref) || !ref.startsWith('#/')) return undefined;
      seen.add(ref);
      current = ref.slice(2).split('/').reduce<unknown>((node, key) => (isObject(node) ? node[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), this.doc);
    }
    return isObject(current) ? current : undefined;
  }

  /** A schema with its references resolved and its allOf members merged (properties and required lists unioned). */
  private schemaOf(value: unknown, depth = 0): Json | undefined {
    const schema = this.resolve(value);
    if (!schema || !Array.isArray(schema.allOf) || depth >= MAX_DEPTH) return schema;
    const properties: Json = { ...(isObject(schema.properties) ? schema.properties : {}) };
    const required: string[] = Array.isArray(schema.required) ? [...schema.required] : [];
    let description = schema.description;
    for (const part of schema.allOf) {
      const member = this.schemaOf(part, depth + 1);
      if (!member) continue;
      if (isObject(member.properties)) Object.assign(properties, member.properties);
      if (Array.isArray(member.required)) required.push(...member.required);
      description ??= member.description;
    }
    const { allOf: _allOf, ...rest } = schema;
    return { ...rest, type: 'object', properties, required, ...(description ? { description } : {}) };
  }

  private refName(value: unknown): string | undefined {
    return isObject(value) && typeof value.$ref === 'string' ? value.$ref.split('/').pop() : undefined;
  }

  private typeOf(schema: Json | undefined): string {
    if (!schema) return 'string';
    if (schema.type === 'array') {
      const items = this.schemaOf(schema.items);
      return items && (items.type === 'object' || isObject(items.properties)) ? 'array' : `${typeof items?.type === 'string' ? items.type : 'string'}[]`;
    }
    if (typeof schema.type === 'string') return schema.type;
    return isObject(schema.properties) ? 'object' : 'string';
  }

  private enumOf(schema: Json | undefined): string[] | undefined {
    const source = schema?.type === 'array' ? this.schemaOf(schema.items) : schema;
    const values = Array.isArray(source?.enum) ? source.enum.filter((value: unknown) => value !== null && value !== undefined).map(String) : [];
    return values.length ? values : undefined;
  }

  private description(text: unknown, key: string): Block[] {
    return typeof text === 'string' && text.trim() ? this.ctx.markdown(text.trim(), `${key}:${this.count++}`) : [];
  }

  private id(kind: string, content: string): string {
    return nodeId(this.ctx.file, [this.count++], `${kind}:${content}`);
  }

  private text(value: string): Inline {
    return { id: this.id('text', value), type: 'text', value };
  }

  private code(value: string): Inline {
    return { id: this.id('code', value), type: 'inlineCode', value };
  }

  private strong(value: string): Inline {
    return { id: this.id('strong', value), type: 'strong', children: [this.text(value)] };
  }

  private paragraph(children: Inline[]): Block {
    return { id: this.id('paragraph', ''), type: 'paragraph', children };
  }

  private label(value: string): Block {
    return this.paragraph([this.strong(value)]);
  }

  private component(name: string, props: ComponentNode['props'], children: Block[]): ComponentNode {
    return { id: this.id(name, JSON.stringify(props)), type: 'component', name, platform: 'gitbook', props, children };
  }
}
