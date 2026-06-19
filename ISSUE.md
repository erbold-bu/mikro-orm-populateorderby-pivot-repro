<!-- Suggested title: -->
<!-- populateOrderBy for a sibling relation leaks into a M:N pivot load and throws under select-in / balanced -->

## Describe the bug

Take an entity with two relations — a **many-to-many** (`Book.tags`) and a separate **one-to-many**
(`Book.labels`). Loading it while you **populate `tags`** *and* **order `labels`** throws:

```ts
await em.find(Book, {}, {
  populate: ['tags', 'labels'],
  populateOrderBy: { labels: { position: 'ASC' } },
});
// ❌ Trying to order by not existing property book_tags.labels
```

Why this happens, step by step:

1. `tags` is many-to-many, so MikroORM loads it with a **separate query against its pivot table
   `book_tags`** — this is what `select-in` (and the v7-default `balanced`) do. `joined` instead folds
   the M:N into the main query, which is why `joined` does **not** hit this.
2. That pivot query is wrongly handed the **`labels` ordering**, which was meant for the `labels`
   relation, not for `tags`.
3. The `book_tags` pivot has no `labels` column → it throws
   `Trying to order by not existing property book_tags.labels`.

In one line: **an `orderBy` meant for one relation leaks into the side-query that loads a _different_
relation.**

**Root cause:** `AbstractSqlDriver.loadFromPivotTable` builds the pivot sub-query options by spreading
the parent `...options` (which carries `populateOrderBy`), recomputes `orderBy`, and clears
`populateWhere` / `_populateWhere` — but it never clears `populateOrderBy`. So the sibling's
`populateOrderBy` rides into the pivot `find`, and `buildOrderBy` → `buildPopulateOrderBy` resolves
the sibling field against the pivot meta and throws.

```ts
// @mikro-orm/sql (v7) | @mikro-orm/knex (v6) — AbstractSqlDriver.loadFromPivotTable
const pivotFindOptions = {
  ctx,
  ...options,                       // ← carries the parent query's populateOrderBy
  fields, exclude,
  orderBy: this.getPivotOrderBy(prop, pivotProp1, orderBy, options?.orderBy),
  populate: [ ... ],
  populateWhere: undefined,         // cleared
  _populateWhere: 'infer',          // cleared
  // populateOrderBy: NOT cleared   ← the leak
};
```

**Suggested fix:** clear `populateOrderBy` in the pivot sub-query options alongside `populateWhere`,
i.e. add `populateOrderBy: undefined` to the `loadFromPivotTable` block (and the polymorphic-pivot
block in `loadFromPolymorphicPivotTable`).

## Reproduction

Minimal runnable repro (built from the official `mikro-orm/reproduction` template — vitest +
`@mikro-orm/sqlite`, `:memory:`):

👉 **https://github.com/erbold-bu/mikro-orm-populateorderby-pivot-repro**

```bash
npm install && npm test
```

`[A]`, `[B]`, and `loadStrategy: joined` pass; **`select-in` and `balanced` throw**.

The essence (`src/example.test.ts`):

```ts
@Entity()
class Tag { @PrimaryKey() id!: number; @Property() name!: string; }

@Entity()
class Book {
  @PrimaryKey() id!: number;
  @Property() title!: string;
  @ManyToMany(() => Tag) tags = new Collection<Tag>(this);          // M:N -> pivot (book_tags)
  @OneToMany(() => Label, l => l.book) labels = new Collection<Label>(this); // sibling O:M
}

@Entity()
class Label {
  @PrimaryKey() id!: number;
  @Property() position!: number;
  @ManyToOne(() => Book) book!: Book;
}

// THROWS under select-in / balanced: "Trying to order by not existing property book_tags.labels"
await orm.em.find(Book, {}, {
  populate: ['tags', 'labels'],
  populateOrderBy: { labels: { position: 'ASC' } },
});
```

Each ingredient alone is fine — `populate: ['tags', 'labels']` without `populateOrderBy`, or
`populateOrderBy` without populating the M:N. Only the combination throws.

## Expected behavior

The query resolves — a sibling relation's `populateOrderBy` should not be applied to the M:N pivot
load. It works under `joined`; it throws under `select-in` and `balanced`.

## Why it only surfaced after upgrading v6 → v7

The leak exists in **both** v6 (`@mikro-orm/knex`) and v7 (`@mikro-orm/sql`) — it is not new. Only the
default `loadStrategy` changed:

| `loadStrategy` | v6.5.7 | v7.1.4 |
|---|---|---|
| `joined`    | ✅ no throw            | ✅ no throw            |
| `select-in` | ❌ throws `book_tags.labels` | ❌ throws `book_tags.labels` |
| `balanced`  | ❌ throws `book_tags.labels` | ❌ throws `book_tags.labels` |

- v6 default `joined` → the M:N is joined into the root query; `loadFromPivotTable` is never called → no leak.
- v7 default `balanced` → the M:N is loaded via a separate select-in pivot query → the leak fires.

Cross-confirmed: `v7 + loadStrategy: 'joined'` → no throw; `v6 + loadStrategy: 'select-in'` → the
identical throw. **Workaround:** force `loadStrategy: 'joined'` globally.

## What driver are you using?

`@mikro-orm/sqlite` (also reproduced on `@mikro-orm/postgresql`). The throw is driver-agnostic — it
depends only on the load strategy.

## MikroORM version

`7.1.4` (also reproduces on `next`, `7.1.5-dev.20`).

## Node.js version

`v24.x` (TypeScript `5.9.x`).

## Operating system

Linux.

## Related (distinct) issues

- #5693 — `populateOrderBy` *ignored* on `select-in` (silent, no throw).
- #1331 — `orderBy` not applied to nested collections under `JOINED`.
- #6757 — `orderBy` + `populate` "no such column".

Those are about order-by being *ignored/mis-applied*; this one is a **hard throw** from
`loadFromPivotTable` leaking a sibling `populateOrderBy` into the pivot query.
