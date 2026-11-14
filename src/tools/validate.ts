/** JSON Schema validation of run_tool arguments against each tool's stored schema. */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { JsonSchema } from './types.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export class SchemaValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  private readonly cache = new Map<string, { schema: JsonSchema; fn: ValidateFunction }>();

  validate(toolName: string, schema: JsonSchema, args: unknown): ValidationResult {
    let entry = this.cache.get(toolName);
    if (!entry || entry.schema !== schema) {
      // GEV schemas carry no $schema/$id; strip them defensively so one tool's
      // id can't collide with another's in the shared Ajv instance.
      const { $id: _id, $schema: _s, ...rest } = schema as Record<string, unknown>;
      entry = { schema, fn: this.ajv.compile(rest) };
      this.cache.set(toolName, entry);
    }
    const ok = entry.fn(args) as boolean;
    return { ok, errors: ok ? [] : formatErrors(entry.fn.errors ?? []) };
  }
}

export function formatErrors(errors: ErrorObject[]): string[] {
  const out = errors.slice(0, 10).map((e) => {
    const where = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(arguments)';
    if (e.keyword === 'additionalProperties') {
      return `${where}: unexpected property "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    }
    if (e.keyword === 'required') {
      return `${where}: missing required property "${(e.params as { missingProperty: string }).missingProperty}"`;
    }
    return `${where}: ${e.message ?? e.keyword}`;
  });
  return Array.from(new Set(out));
}
