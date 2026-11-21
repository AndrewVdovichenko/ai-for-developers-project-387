# Список предстоящих встреч: план SQL ([#23](https://github.com/AndrewVdovichenko/ai-for-developers-project-386/issues/23))

Замер 19 ноября 2026 года в локальной PostgreSQL, в отдельной временной базе
после всех миграций. Набор: 100 000 подтверждённых Записей, два Типа встречи,
99 980 завершённых и 20 предстоящих. Фильтр выбирает 10 предстоящих Записей.
Время решения фиксировано: `2026-11-19T00:00:00.000Z`.

Индексы `bookings_ends` и `bookings_type_ends` уже созданы миграцией 008.
Запрос выполняет отбор `ends_at > $1`, объединение с Типами встречи и сортировку
по `starts_at, id`; фильтр добавляет `event_type_id = ANY($2::uuid[])`.

| Запрос   | Возвращено | Planning Time | Execution Time |       Буферы |
| -------- | ---------: | ------------: | -------------: | -----------: |
| Все типы |         20 |      0.114 ms |       0.026 ms | shared hit=7 |
| Один тип |         10 |      0.055 ms |       0.018 ms | shared hit=5 |

Планировщик выбрал индекс окончания для обоих запросов и отсеял 10 строк
фильтром во втором. История не читается целиком. Это локальный замер
с прогретым кешем, без оценки сетевых задержек; конкретный индекс
и порог времени тестами не фиксируются.

## EXPLAIN (ANALYZE, BUFFERS)

```text
ALL Sort  (cost=15.41..15.49 rows=31 width=125) (actual time=0.017..0.018 rows=20.00 loops=1)
  Sort Key: b.starts_at, b.id
  Sort Method: quicksort  Memory: 27kB
  Buffers: shared hit=7
  ->  Nested Loop  (cost=0.45..14.64 rows=31 width=125) (actual time=0.006..0.012 rows=20.00 loops=1)
        Buffers: shared hit=7
        ->  Index Scan using bookings_ends on bookings b  (cost=0.29..8.84 rows=31 width=93) (actual time=0.001..0.003 rows=20.00 loops=1)
              Index Cond: (ends_at > '2026-11-19 00:00:00+00'::timestamp with time zone)
              Index Searches: 1
              Buffers: shared hit=3
        ->  Memoize  (cost=0.16..1.73 rows=1 width=48) (actual time=0.000..0.000 rows=1.00 loops=20)
              Cache Key: b.event_type_id
              Cache Mode: logical
              Hits: 18  Misses: 2  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              Buffers: shared hit=4
              ->  Index Scan using event_types_pkey on event_types t  (cost=0.15..1.72 rows=1 width=48) (actual time=0.001..0.001 rows=1.00 loops=2)
                    Index Cond: (id = b.event_type_id)
                    Index Searches: 2
                    Buffers: shared hit=4
Planning:
  Buffers: shared hit=78
Planning Time: 0.114 ms
Execution Time: 0.026 ms
FILTERED Sort  (cost=18.43..18.46 rows=15 width=125) (actual time=0.011..0.012 rows=10.00 loops=1)
  Sort Key: b.starts_at, b.id
  Sort Method: quicksort  Memory: 26kB
  Buffers: shared hit=5
  ->  Nested Loop  (cost=0.45..18.13 rows=15 width=125) (actual time=0.005..0.009 rows=10.00 loops=1)
        Buffers: shared hit=5
        ->  Index Scan using bookings_ends on bookings b  (cost=0.29..8.87 rows=15 width=93) (actual time=0.002..0.004 rows=10.00 loops=1)
              Index Cond: (ends_at > '2026-11-19 00:00:00+00'::timestamp with time zone)
              Filter: (event_type_id = ANY ('{00000000-0000-0000-0000-000000000001}'::uuid[]))
              Rows Removed by Filter: 10
              Index Searches: 1
              Buffers: shared hit=3
        ->  Memoize  (cost=0.16..3.11 rows=1 width=48) (actual time=0.000..0.000 rows=1.00 loops=10)
              Cache Key: b.event_type_id
              Cache Mode: logical
              Hits: 9  Misses: 1  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              Buffers: shared hit=2
              ->  Index Scan using event_types_pkey on event_types t  (cost=0.15..3.10 rows=1 width=48) (actual time=0.001..0.001 rows=1.00 loops=1)
                    Index Cond: (id = b.event_type_id)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=3
Planning Time: 0.055 ms
Execution Time: 0.018 ms
```

## Воспроизведение

Скрипт запускается из корня worktree после `yarn install` через
`mise exec -- yarn workspace @calendar/api exec tsx /tmp/owner-bookings-plan.mts`.
Путь импорта нужно заменить абсолютным путём своего worktree. Он создаёт
отдельную базу, применяет миграции, заполняет только её и удаляет базу
в `finally`. SQL ниже задаёт тот же набор и запрос, что использованы при замере.

```typescript
import { testDatabase } from '/tmp/calendar-ticket-23/apps/api/test/database.ts';
const db = await testDatabase();
try {
  await db.migrate();
  await db.pool.query(
    `INSERT INTO event_types(id,name,description,duration_minutes) VALUES('00000000-0000-0000-0000-000000000001','Звонок','',30),('00000000-0000-0000-0000-000000000002','Другой','',30)`,
  );
  await db.pool.query(
    `INSERT INTO guests(id,secret_hash,expires_at) VALUES('00000000-0000-0000-0000-000000000001','plan',now()+interval '1 year')`,
  );
  await db.pool
    .query(`INSERT INTO holds(id,guest_id,event_type_id,starts_at,ends_at,expires_at,state)
 SELECT md5('hold'||i)::uuid,'00000000-0000-0000-0000-000000000001'::uuid,CASE WHEN i%2=0 THEN '00000000-0000-0000-0000-000000000001'::uuid ELSE '00000000-0000-0000-0000-000000000002'::uuid END,
 '2020-01-01'::timestamptz+i*interval '15 minutes','2020-01-01'::timestamptz+i*interval '15 minutes'+interval '30 minutes','2020-01-01', 'confirmed' FROM generate_series(1,100000) i`);
  await db.pool
    .query(`INSERT INTO bookings(id,hold_id,guest_id,event_type_id,starts_at,ends_at,guest_name,guest_email)
 SELECT md5('booking'||id)::uuid,id,guest_id,event_type_id,starts_at,ends_at,'Гость','guest@example.com' FROM holds`);
  await db.pool.query(
    `WITH recent AS (SELECT id FROM bookings ORDER BY starts_at DESC LIMIT 20) UPDATE bookings SET starts_at='2026-11-19'::timestamptz,ends_at='2026-11-20'::timestamptz WHERE id IN (SELECT id FROM recent)`,
  );
  await db.pool.query('ANALYZE bookings');
  for (const filter of [false, true]) {
    const result = await db.pool.query(
      `EXPLAIN (ANALYZE, BUFFERS) SELECT b.id,b.hold_id,b.event_type_id,t.name,b.starts_at,b.ends_at,b.guest_name,b.guest_email FROM bookings b JOIN event_types t ON t.id=b.event_type_id WHERE b.ends_at>$1 ${filter ? 'AND b.event_type_id=ANY($2::uuid[])' : ''} ORDER BY b.starts_at,b.id`,
      filter
        ? ['2026-11-19T00:00:00Z', ['00000000-0000-0000-0000-000000000001']]
        : ['2026-11-19T00:00:00Z'],
    );
    console.log(filter ? 'FILTERED' : 'ALL', result.rows.map((r) => r['QUERY PLAN']).join('\n'));
  }
} finally {
  await db.close();
}
```
