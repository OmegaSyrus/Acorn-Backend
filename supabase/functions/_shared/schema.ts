// The JSON Schema subset the contract uses (contract/README.md, "The schema
// subset"), with no dependencies. tools/check_contract.py is the same checker
// in Python and the game's tests/support/schema_check.gd in GDScript.

// deno-lint-ignore no-explicit-any
type Json = any;
// deno-lint-ignore no-explicit-any
export type Schema = Record<string, any>;

function isType(v: Json, t: string): boolean {
  switch (t) {
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number";
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
  }
  return false;
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function schemaErrors(value: Json, schema: Schema, root: Schema = schema, at = "$"): string[] {
  if (schema.$ref) {
    const name = String(schema.$ref).split("/").pop()!;
    return schemaErrors(value, root.$defs[name], root, at);
  }
  const out: string[] = [];
  if ("const" in schema && !same(value, schema.const)) out.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e: Json) => same(value, e))) out.push(`${at}: not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) return [...out, `${at}: not ${types.join(" or ")}`];
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    out.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if ("minimum" in schema && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if ("maximum" in schema && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
  }
  if (isType(value, "object")) {
    for (const k of schema.required ?? []) if (!(k in value)) out.push(`${at}: missing ${k}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out.push(...schemaErrors(v, props[k], root, `${at}.${k}`));
      else if (isType(schema.additionalProperties, "object")) out.push(...schemaErrors(v, schema.additionalProperties, root, `${at}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => out.push(...schemaErrors(v, schema.items, root, `${at}[${i}]`)));
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s: Schema) => schemaErrors(value, s, root, at).length === 0).length;
    if (n !== 1) out.push(`${at}: matches ${n} of oneOf, not 1`);
  }
  return out;
}
