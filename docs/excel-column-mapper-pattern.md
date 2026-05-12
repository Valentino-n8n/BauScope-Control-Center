# Excel Column Mapper Pattern

When you read an Excel table via Microsoft Graph, each row arrives
as `{ index, values: [[col0, col1, col2, ...]] }`. Reading a value
looks like:

```js
const envelopeId = row.values[0][14];
```

This works. It also breaks the day someone inserts a column at
position 5: every reference to columns 5+ now points at the wrong
data, silently. Tests don't catch it because the test data has the
new column too.

The mapper pattern decouples column **names** from column **indexes**
behind a single config object, and gives you a small typed-feeling
API for accessing columns by name. One change to the index map
when columns shift; everything else keeps working.

## What the pattern provides

A `Mapper` class with five methods:

- **`get(row, columnName)`** — read one value
- **`getAll(row)`** — read the whole row as a flat object
- **`buildRow(data)`** — convert a `{column: value}` object to a
  positional array suitable for Microsoft Graph PATCH/POST
- **`findRow(rows, columnName, value)`** — first row matching a
  predicate
- **`filterRows(rows, columnName, value)`** — all rows matching

The full implementation is in
[`../snippets/excel-column-mapper.js`](../snippets/excel-column-mapper.js).

## Why this isn't over-engineering

For a table with three columns, this is overkill — just use the
indexes directly. The mapper earns its keep when:

- The table has 10+ columns
- Multiple workflows read or write the same table
- Columns get added or reordered as the operational process evolves

This platform's main cases table has 16 columns and is read or
written by all three workflows (home tab, interactions, DocuSign).
Without the mapper, a column shift requires hunting through
hundreds of `row.values[0][N]` references across the codebase. With
it, change one line in the index config.

---

## Config shape

Every workflow that uses the mapper starts with a config node:

```js
const config = {
  excelColumns: {
    indexes: {
      entryId: 0,
      caseNumber: 1,
      itemId: 2,
      createdDate: 3,
      createdBy: 4,
      objectStreet: 5,
      objectCity: 6,
      objectAddress: 7,
      customerName: 8,
      customerEmail: 9,
      customerPhone: 10,
      internalNote: 11,
      docusignSentDate: 12,
      docusignCompletedDate: 13,
      docusignEnvelopeId: 14,
      caseStatus: 15,
    },
  },
};
```

Every Code node that touches the cases table reads from this
config. Adding a column at position 6 means: update the config
(everything from `objectCity` downward gets +1), every other Code
node continues to work because they all reference column **names**,
not numbers.

In production, the config lives in a single Code node (`Global
Config`) at the top of the workflow; downstream nodes pull from
`$('Global Config').first().json`.

---

## Common usage patterns

### Reading

```js
const mapper = createExcelMapper(config);

// One column from one row
const envelopeId = mapper.get(row, "docusignEnvelopeId");

// Whole row as an object — convenient for log messages
const allFields = mapper.getAll(row);
console.log("Processing case:", allFields.caseNumber, allFields.customerName);
```

### Searching

```js
// First row whose envelope ID matches the webhook
const matchingRow = mapper.findRow(rows, "docusignEnvelopeId", envelopeId);

if (!matchingRow) {
  throw new Error(`No row for envelope ${envelopeId}`);
}
```

### Writing

```js
// Build an Excel row from a domain object — handles the array
// indexes for you, fills missing columns with empty string
const newRow = mapper.buildRow({
  caseNumber: "FS-0162",
  createdDate: dateToExcelSerial(new Date()),
  createdBy: "@valentino",
  customerName: "Acme GmbH",
  customerEmail: "ops@acme.example",
  caseStatus: "pending",
});

// newRow is now a 16-element array ready for Microsoft Graph PATCH
```

### Targeted PATCH

```js
// PATCH a single column without re-sending the whole row
const partialUpdate = mapper.buildRow({
  docusignCompletedDate: dateToExcelSerial(new Date()),
  caseStatus: "completed",
});
// All other columns stay empty in `partialUpdate`. If your Graph
// PATCH semantics treat empty strings as "leave alone", great. If
// they treat empty strings as "clear", you need a different shape:
// fetch the row first, modify the two fields, write back.
```

---

## Trade-offs

**Trade-off 1: an extra abstraction layer.** New developers reading
the workflow have to learn the mapper pattern before they can read
any Code node. For a small team, this is a net cost; for a workflow
that lasts years, it's a net win.

**Trade-off 2: typo-prone column names.** `mapper.get(row, "envelopId")`
(missing 'e') returns `undefined` silently, not an error. The
implementation in the snippet **throws** on unknown column names
specifically to surface this. Without that check, the bug is
indistinguishable from "the column is genuinely empty for this row".

**Trade-off 3: the indexes still have to be right.** The mapper
doesn't know what column 14 actually is in your Excel sheet — only
what you've configured it as. If your config says
`docusignEnvelopeId: 14` but the actual column 14 is
`customerEmail`, the mapper happily returns the wrong values with
the wrong name. There's no schema validation against the live
sheet. A sanity check at workflow start (read a header row, verify
expected column names match expected indexes) is a useful guard
for high-stakes workflows.

---

## When NOT to use this pattern

- **Quick scripts, one-off automations.** The setup cost isn't
  worth it.
- **Tables with stable, well-understood columns.** If the table
  schema hasn't changed in a year and won't change again, hardcoded
  indexes are fine.
- **Heavy ETL pipelines.** Use a real data-frame library
  (Pandas-equivalent in Node, or just move the work to Python).

This pattern fits the middle ground: long-lived workflows over
spreadsheets that will keep evolving.
