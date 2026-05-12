/**
 * Excel Column Mapper
 * ===================
 *
 * Type-safe access to Excel rows fetched via Microsoft Graph.
 * Replaces hard-coded `row.values[0][14]` with
 * `mapper.get(row, 'envelopeId')` — one place to update when
 * columns shift.
 *
 * USAGE:
 *
 *   const config = $('Global Config').first().json;
 *   const mapper = createExcelMapper(config.excelColumns);
 *
 *   const envelopeId = mapper.get(row, 'envelopeId');
 *   const allFields = mapper.getAll(row);
 *   const newRow    = mapper.buildRow({ caseNumber: 'FS-0162', ... });
 *   const matching  = mapper.findRow(rows, 'envelopeId', '...');
 *   const filtered  = mapper.filterRows(rows, 'status', 'pending');
 *
 * The config shape:
 *
 *   {
 *     indexes: {
 *       caseNumber: 1,
 *       customerName: 8,
 *       envelopeId:   14,
 *       status:       15,
 *       ...
 *     },
 *     totalColumns: 16,
 *   }
 *
 * Used in: n8n Code node, after a Microsoft Graph "list rows" call.
 */

class ExcelMapper {
  constructor(columnConfig) {
    this.indexes = columnConfig.indexes;
    this.totalColumns = columnConfig.totalColumns || 16;
  }

  /**
   * Read one column value from a row.
   * Throws on unknown column name to surface typos.
   */
  get(row, columnName) {
    if (!row || !row.values || !row.values[0]) {
      throw new Error("Invalid Excel row structure");
    }
    const index = this.indexes[columnName];
    if (index === undefined) {
      throw new Error(
        `Unknown column "${columnName}". ` +
          `Known: ${Object.keys(this.indexes).join(", ")}`,
      );
    }
    return row.values[0][index];
  }

  /**
   * Read the entire row as a flat object keyed by column name.
   * Includes _rowIndex for downstream PATCH calls.
   */
  getAll(row) {
    if (!row || !row.values || !row.values[0]) {
      throw new Error("Invalid Excel row structure");
    }
    const result = { _rowIndex: row.index };
    for (const [name, index] of Object.entries(this.indexes)) {
      result[name] = row.values[0][index];
    }
    return result;
  }

  /**
   * Build an array suitable for Microsoft Graph PATCH/POST from a
   * `{ columnName: value }` object. Missing columns become "".
   */
  buildRow(data) {
    const row = new Array(this.totalColumns).fill("");
    for (const [name, index] of Object.entries(this.indexes)) {
      if (data[name] !== undefined && data[name] !== null) {
        row[index] = data[name];
      }
    }
    return row;
  }

  /**
   * Find the first row whose named column matches the given value.
   * Returns null if not found.
   */
  findRow(rows, columnName, value) {
    const index = this.indexes[columnName];
    if (index === undefined) {
      throw new Error(`Unknown column "${columnName}"`);
    }
    return (
      rows.find(
        (row) => row.values && row.values[0] && row.values[0][index] === value,
      ) || null
    );
  }

  /**
   * Filter rows by named column value. Returns an array.
   */
  filterRows(rows, columnName, value) {
    const index = this.indexes[columnName];
    if (index === undefined) {
      throw new Error(`Unknown column "${columnName}"`);
    }
    return rows.filter(
      (row) => row.values && row.values[0] && row.values[0][index] === value,
    );
  }
}

function createExcelMapper(columnConfig) {
  return new ExcelMapper(columnConfig);
}

// ── Example usage in this node ────────────────────────────────
const config = $("Global Config").first().json.excelColumns;
const mapper = createExcelMapper(config);

const rows = $input.first().json.value || [];
const targetEnvelope = $("Parse DocuSign Event").first().json.envelopeId;

const matchingRow = mapper.findRow(rows, "envelopeId", targetEnvelope);
if (!matchingRow) {
  throw new Error(`No row found for envelope ${targetEnvelope}`);
}

return [
  {
    json: {
      caseData: mapper.getAll(matchingRow),
      rowIndex: matchingRow.index,
    },
  },
];
