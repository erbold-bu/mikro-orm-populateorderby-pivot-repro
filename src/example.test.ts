import 'reflect-metadata';
import { Entity, PrimaryKey, Property, ManyToOne, OneToMany, ManyToMany, ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Collection, MikroORM } from '@mikro-orm/sqlite';

// NB: with `emitDecoratorMetadata`, a property's class type is evaluated eagerly at
// decoration time, so an entity must be declared before any sibling that annotates a
// property with its type. Hence Book is declared before Label (Label.book: Book).

@Entity()
class Tag {

  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

}

@Entity()
class Book {

  @PrimaryKey()
  id!: number;

  @Property()
  title!: string;

  // many-to-many -> loaded via the pivot table (`book_tags`) under select-in / balanced
  @ManyToMany(() => Tag)
  tags = new Collection<Tag>(this);

  // sibling one-to-many that we order with populateOrderBy
  @OneToMany(() => Label, l => l.book)
  labels = new Collection<Label>(this);

}

@Entity()
class Label {

  @PrimaryKey()
  id!: number;

  @Property()
  position!: number;

  @ManyToOne(() => Book)
  book!: Book;

}

type Strategy = 'joined' | 'select-in' | 'balanced';

async function makeOrm(loadStrategy?: Strategy) {
  const orm = await MikroORM.init({
    dbName: ':memory:',
    entities: [Book, Tag, Label],
    metadataProvider: ReflectMetadataProvider,
    allowGlobalContext: true, // only for testing
    ...(loadStrategy ? { loadStrategy } : {}),
  });
  await orm.schema.refresh();

  const em = orm.em.fork();
  const book = em.create(Book, { id: 1, title: 'The Book' });
  book.tags.add(em.create(Tag, { id: 1, name: 'alpha' }), em.create(Tag, { id: 2, name: 'beta' }));
  em.create(Label, { id: 1, book, position: 2 });
  em.create(Label, { id: 2, book, position: 1 });
  await em.flush();
  return orm;
}

// --- Controls: each ingredient alone is fine --------------------------------

test('[A] populate the M:N + sibling, NO populateOrderBy -> OK', async () => {
  const orm = await makeOrm();
  try {
    const books = await orm.em.fork().find(Book, {}, { populate: ['tags', 'labels'] });
    expect(books).toHaveLength(1);
  } finally {
    await orm.close(true);
  }
});

test('[B] populateOrderBy(labels) WITHOUT populating the M:N -> resolves (no throw)', async () => {
  const orm = await makeOrm('select-in');
  try {
    await expect(
      orm.em.fork().find(Book, {}, { populate: ['labels'], populateOrderBy: { labels: { position: 'ASC' } } }),
    ).resolves.toBeDefined();
  } finally {
    await orm.close(true);
  }
});

// --- The bug: populate the M:N AND populateOrderBy a sibling, per strategy ----
// The query must at least RUN. `joined` runs; `select-in` and `balanced` THROW
//   "Trying to order by not existing property book_tags.labels"
// because the sibling order-by leaks into the M:N pivot sub-query (loadFromPivotTable).
// (We only assert it doesn't throw — the *correctness* of the joined collection order is a
//  separate, pre-existing concern, see mikro-orm/mikro-orm#1331.)
describe('[C] populate M:N (tags) + populateOrderBy(sibling labels) — must not throw', () => {
  for (const loadStrategy of ['joined', 'select-in', 'balanced'] as const) {
    test(`loadStrategy: ${loadStrategy}`, async () => {
      const orm = await makeOrm(loadStrategy);
      try {
        await expect(
          orm.em.fork().find(Book, {}, {
            populate: ['tags', 'labels'],
            populateOrderBy: { labels: { position: 'ASC' } },
          }),
        ).resolves.toBeDefined();
      } finally {
        await orm.close(true);
      }
    });
  }
});
