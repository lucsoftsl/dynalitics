import type { ColumnInfo } from '../dialect/types.js';
import type { ColumnDef, ColumnModel, Dialect, ResolvedCustomField, Role } from './types.js';

export interface LengthAdoption {
  readonly column: string;
  readonly configured: number;
  readonly real: number;
}

const INTEGER_TYPES: ReadonlySet<string> = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'bigint',
  'tinyint',
  'mediumint',
  'int',
]);
/** True if the real column is an integer type, so a boolean has to be bound as 1/0 (and read as a number). */
export const isIntegerColumn = (c: ColumnDef | undefined): boolean =>
  c?.physicalType !== undefined && INTEGER_TYPES.has(c.physicalType);

/**
 * Returns a copy of the model that knows the real database types (from the catalog). In `existing` mode string
 * columns also adopt the real length when it is shorter than configured (spec 7.2); unlimited types keep the configured
 * maximum. Recommended tables keep their lengths: a shorter real column is the `too_short` problem there.
 */
export function adoptPhysical(
  model: ColumnModel,
  catalog: readonly ColumnInfo[],
  dialect: Dialect,
): { readonly model: ColumnModel; readonly adopted: readonly LengthAdoption[] } {
  const key = (n: string): string => (dialect === 'postgres' ? n : n.toLowerCase());
  const byName = new Map(catalog.map((c) => [key(c.name), c]));
  const adopted: LengthAdoption[] = [];

  const refine = (c: ColumnDef): ColumnDef => {
    const info = byName.get(key(c.name));
    if (info === undefined) return c;
    const withType: ColumnDef = { ...c, physicalType: info.dataType };
    if (
      model.mode === 'existing' &&
      c.type.kind === 'string' &&
      info.maxLength !== null &&
      info.maxLength > 0 &&
      info.maxLength < c.type.maxLength
    ) {
      adopted.push({ column: c.name, configured: c.type.maxLength, real: info.maxLength });
      return { ...withType, type: { kind: 'string', maxLength: info.maxLength } };
    }
    return withType;
  };

  const columns = model.columns.map(refine);
  const byColumnName = new Map(columns.map((c) => [c.name, c]));
  const byRole = (role: Role): ColumnDef | undefined => columns.find((c) => c.role === role);

  const customFields = new Map<string, ResolvedCustomField>();
  for (const [name, field] of model.customFields) {
    const column = field.column === undefined ? undefined : byColumnName.get(field.column.name);
    customFields.set(name, {
      ...field,
      ...(column === undefined
        ? {}
        : {
            column,
            maxLength: column.type.kind === 'string' ? column.type.maxLength : field.maxLength,
          }),
    });
  }

  const userId = byRole('userId');
  const ip = byRole('ip');
  return {
    model: {
      ...model,
      columns,
      insertColumns: columns.filter((c) => !c.dbGenerated),
      customFields,
      identity: {
        ...(userId === undefined ? {} : { userId }),
        ...(ip === undefined ? {} : { ip }),
      },
    },
    adopted,
  };
}
