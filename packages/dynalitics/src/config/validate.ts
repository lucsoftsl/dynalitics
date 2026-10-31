/**
 * A tiny declarative validator (no dependencies). Each rule appends human-readable issues with a dotted path;
 * nothing throws, so the caller can report every problem at once. Values are never echoed back, only their kind,
 * so secrets cannot leak through validation messages.
 */
export type Issues = string[];
export type Rule = (value: unknown, path: string, issues: Issues) => void;

const kindOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str =
  (o: { min?: number; max?: number; pattern?: RegExp; hint?: string } = {}): Rule =>
  (v, path, issues) => {
    if (typeof v !== 'string')
      return void issues.push(`${path}: expected a string, got ${kindOf(v)}`);
    if (o.min !== undefined && v.length < o.min)
      issues.push(`${path}: expected at least ${o.min} characters`);
    if (o.max !== undefined && v.length > o.max)
      issues.push(`${path}: expected at most ${o.max} characters`);
    if (o.pattern !== undefined && !o.pattern.test(v))
      issues.push(`${path}: ${o.hint ?? 'has an invalid format'}`);
  };

export const int =
  (o: { min: number; max: number }): Rule =>
  (v, path, issues) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < o.min || v > o.max) {
      issues.push(
        `${path}: expected integer ${o.min}..${o.max}, got ${typeof v === 'number' ? String(v) : kindOf(v)}`,
      );
    }
  };

export const bool: Rule = (v, path, issues) => {
  if (typeof v !== 'boolean') issues.push(`${path}: expected a boolean, got ${kindOf(v)}`);
};

export const oneOf =
  (allowed: readonly string[]): Rule =>
  (v, path, issues) => {
    if (typeof v !== 'string' || !allowed.includes(v)) {
      issues.push(`${path}: expected one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
    }
  };

export const fn: Rule = (v, path, issues) => {
  if (typeof v !== 'function') issues.push(`${path}: expected a function, got ${kindOf(v)}`);
};

export const anyObject: Rule = (v, path, issues) => {
  if (typeof v !== 'object' || v === null)
    issues.push(`${path}: expected an object, got ${kindOf(v)}`);
};

/** Marks a key as required inside obj(). */
export const req = (rule: Rule): Rule & { required: true } =>
  Object.assign<Rule, { required: true }>((v, path, issues) => rule(v, path, issues), {
    required: true,
  });

export const obj =
  (shape: Readonly<Record<string, Rule>>): Rule =>
  (v, path, issues) => {
    if (!isPlainObject(v)) return void issues.push(`${path}: expected an object, got ${kindOf(v)}`);
    for (const key of Object.keys(v)) {
      if (!Object.hasOwn(shape, key)) issues.push(`${path}.${key}: unknown key`);
    }
    for (const [key, rule] of Object.entries(shape)) {
      const present = Object.hasOwn(v, key) && v[key] !== undefined;
      if (!present) {
        if ((rule as { required?: boolean }).required === true)
          issues.push(`${path}.${key}: required`);
        continue;
      }
      rule(v[key], `${path}.${key}`, issues);
    }
  };

export const rec =
  (rule: Rule): Rule =>
  (v, path, issues) => {
    if (!isPlainObject(v)) return void issues.push(`${path}: expected an object, got ${kindOf(v)}`);
    for (const [key, value] of Object.entries(v)) rule(value, `${path}.${key}`, issues);
  };

export const custom =
  (check: (value: unknown, path: string, issues: Issues) => void): Rule =>
  (v, path, issues) =>
    check(v, path, issues);

export function runRule(rule: Rule, value: unknown, path: string): Issues {
  const issues: Issues = [];
  rule(value, path, issues);
  return issues;
}
