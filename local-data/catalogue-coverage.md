# Catalogue coverage report

Generated from the current `local-data/madhouse.sqlite` projection on 2026-10-20. The public-client routing table hash is `b3a27973995a3548e58fd6a3a8b315ebcff60685d700425e8dff1de5039640c8`. Route rows establish identifiers and membership only; API records establish names and definitions.

| Floor | Departments from routes | API-named departments | API boss definitions with route membership |
| ----- | ----------------------: | --------------------: | -----------------------------------------: |
| A     |                       3 |                     3 |                                          6 |
| B     |                       3 |                     3 |                                          6 |
| C     |                       3 |                     3 |                                          6 |
| D     |                       3 |                     3 |                                          6 |
| E     |                       3 |                     3 |                                          6 |
| F     |                       3 |                     3 |                                          6 |
| G     |                       3 |                     3 |                                          6 |
| H     |                       3 |                     3 |                                          6 |
| I     |                       3 |                     0 |                                          6 |
| J     |                       3 |                     0 |                                          6 |
| K     |                       3 |                     0 |                                          6 |
| L     |                       3 |                     0 |                                          6 |
| M     |                       3 |                     0 |                                          6 |
| N     |                       3 |                     0 |                                          8 |
| O     |                       3 |                     0 |                                          6 |
| `$`   |                       3 |                     0 |                                         16 |

The model has 16 floors, 48 department codes, 24 API department definitions with names, and 24 nameless department metadata stubs. All 108 API boss definitions have a routed department. The route table contains 239 memberships (108 boss, 92 business, 39 work); the current API catalogue resolves 108 bosses, 48 businesses, and 24 works to route memberships. The remaining routed business/work IDs have no corresponding API definition in the local catalogue and are not rendered as invented records.

## API routes for filling definition gaps

The importer already requests the definition routes below for discovered IDs, so no additional endpoint is needed:

- `GET /api/floors/{code}/info` for floor and department definitions. The API currently contributes named departments A1–H3; no API department definitions are captured for I–O or `$`.
- `GET /api/bosses/{bossId}` for boss definitions. The current 108 of 108 routed bosses resolve.
- `GET /api/businesses/{businessId}` for business definitions. The current 48 of 92 routed business IDs resolve.
- `POST /api/works/open` for work definitions; this is the existing authorized definition request. The current 24 of 39 routed work IDs resolve.

The distinction between a missing definition and route-only membership is retained in the React model. No names, work titles, costs, or requirements are inferred from the public client.
