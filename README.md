# MikroORM — `populateOrderBy` for a sibling relation leaks into a M:N pivot load and throws

Built from the official [`mikro-orm/reproduction`](https://github.com/mikro-orm/reproduction) template
(vitest + `@mikro-orm/sqlite`, `:memory:`, decorators).

## The bug

A single `find()` that **populates a many-to-many relation** (loaded via its pivot table under the
`select-in` / default-v7 `balanced` strategy) **and** passes `populateOrderBy` for a **different,
sibling** relation throws:

```
Trying to order by not existing property book_tags.labels
```

The sibling relation's order-by hint (`labels`) is applied while building the M:N **pivot** sub-query
(`book_tags`), where that field does not exist.

## Run

```bash
npm install
npm test
```

Expected — the two controls and `joined` pass; **`select-in` and `balanced` fail (throw)**:

```
✓ [A] populate the M:N + sibling, NO populateOrderBy
✓ [B] populateOrderBy(labels) WITHOUT populating the M:N -> resolves
  [C] populate M:N (tags) + populateOrderBy(sibling labels) — must not throw
    ✓ loadStrategy: joined
    ✕ loadStrategy: select-in   → Trying to order by not existing property book_tags.labels
    ✕ loadStrategy: balanced    → Trying to order by not existing property book_tags.labels
```

## Strategy × version matrix

| `loadStrategy` | v6.5.7 | v7.1.4 |
|---|---|---|
| `joined` | ✅ no throw | ✅ no throw |
| `select-in` | ❌ THROW | ❌ THROW |
| `balanced` | ❌ THROW | ❌ THROW |

Identical in both majors — the bug is gated by the **load strategy**, not the version. v6 just
defaulted to `joined`, so it never hit the pivot path; v7 defaults to `balanced`.

## Root cause

`AbstractSqlDriver.loadFromPivotTable` (v7 `@mikro-orm/sql`, v6 `@mikro-orm/knex`) builds the pivot
sub-query options by spreading the parent `...options` (which carries `populateOrderBy`), recomputing
`orderBy`, and clearing `populateWhere` / `_populateWhere` — but it **never clears `populateOrderBy`**.
So the sibling relation's `populateOrderBy` rides into the pivot `find`, and `buildPopulateOrderBy`
resolves the sibling field against the pivot meta and throws.

**Suggested fix:** add `populateOrderBy: undefined` to the `loadFromPivotTable` option block (and the
polymorphic-pivot variant in `loadFromPolymorphicPivotTable`), alongside the existing
`populateWhere: undefined`.

**Workaround:** force `loadStrategy: 'joined'` globally.

## Versions

`@mikro-orm/core` / `@mikro-orm/sqlite` / `@mikro-orm/decorators` pinned to `7.1.4` (see
`package.json`). Also reproduced on `next` (`7.1.5-dev`), on `@mikro-orm/postgresql` at `7.1.4`, and as
a control on `6.5.7`.

See [`ISSUE.md`](./ISSUE.md) for the full write-up.

> Note: a *separate, opposite* bug — `joined` silently dropping a nested collection's `populateOrderBy`
> when it orders by a to-one **relation field** — is reproduced in a companion repo:
> [mikro-orm-joined-nested-orderby-repro](https://github.com/erbold-bu/mikro-orm-joined-nested-orderby-repro).
