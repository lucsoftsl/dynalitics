/** Sanitised copy of a lower-level error. The raw error is never attached to ours (it may carry credentials). */
export interface SafeCause {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export class DynaliticsError extends Error {
  readonly code: string;
  readonly safeCause: SafeCause | undefined;

  constructor(code: string, message: string, safeCause?: SafeCause) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.safeCause = safeCause;
  }
}

/** Thrown synchronously for invalid configuration. Lists every issue found. */
export class DynaliticsConfigError extends DynaliticsError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      'DYNALITICS_CONFIG',
      issues.length === 1
        ? `Invalid dynalitics configuration: ${issues[0] ?? ''}`
        : `Invalid dynalitics configuration (${issues.length} issues):\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.issues = [...issues];
  }
}

/** Thrown when a database cannot be reached or a driver is missing. Message is already redacted. */
export class DynaliticsConnectionError extends DynaliticsError {
  constructor(message: string, safeCause?: SafeCause) {
    super('DYNALITICS_CONNECTION', message, safeCause);
  }
}

export type SchemaProblemCode =
  | 'missing_table'
  | 'not_a_table'
  | 'missing_column'
  | 'type_mismatch'
  | 'too_short'
  | 'not_nullable'
  | 'extra_required_column'
  | 'timestamp_session_timezone'
  | 'identity_not_discoverable';

export interface SchemaProblem {
  readonly code: SchemaProblemCode;
  readonly message: string;
  readonly column?: string;
}

export interface SchemaWarning {
  readonly code: string;
  readonly message: string;
  readonly column?: string;
}

/** Thrown at startup when the table does not match the column model. `fixSql` is printed text, never executed. */
export class DynaliticsSchemaError extends DynaliticsError {
  readonly problems: readonly SchemaProblem[];
  readonly warnings: readonly SchemaWarning[];
  readonly fixSql: string;

  constructor(
    report: string,
    problems: readonly SchemaProblem[],
    warnings: readonly SchemaWarning[],
    fixSql: string,
  ) {
    super('DYNALITICS_SCHEMA', report);
    this.problems = [...problems];
    this.warnings = [...warnings];
    this.fixSql = fixSql;
  }
}
