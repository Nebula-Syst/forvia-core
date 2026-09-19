# forvia-core

The openGym-derived half of [Forvia](https://github.com/Nebula-Syst/Forvia): email/password
auth, sessions, account management, workout/routine/bodyweight/nutrition-diary sync, the base
admin panel, invite codes, bug reports, the exercise-name override list, and push notifications.
See [NOTICE.md](NOTICE.md) for exactly why this exists as its own repository and its own
license.

Forvia's own level/XP/prestige/streaks, social feed, and coach/box system are **not** here —
they live in Forvia's own repository, which talks to this service over a small internal API
(`/internal/*`, shared-secret protected, never exposed publicly).

## Running it

Same shape as Forvia's own backend — no framework, Postgres-backed, one process:

```
docker build -t forvia-core .
docker run -p 3000:3000 \
  -e DATABASE_URL=postgres://forvia:forvia@db:5432/forvia \
  -e ORIGIN=https://app.example.com \
  -e INTERNAL_SECRET=<a long random string, shared with the Nebula service> \
  -e NEBULA_URL=http://forvia-api:3000 \
  -v forvia-uploads:/data/uploads \
  forvia-core
```

It shares one Postgres database with the Nebula service (safe: each owns a disjoint set of
`kv_*` tables, enforced by each service's own `db.js`) and one Docker volume for `/data/uploads`
(avatars live here; social photos/box images/coach documents are the other service's routes but
land in the same per-account folder, so this service's `GET /api/uploads` serves all of it).

See `server.js`'s own top-of-file comment and the `/internal/*` route block for the exact
boundary and how the two services stay in sync.
