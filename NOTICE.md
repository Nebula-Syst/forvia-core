# Third-party notices

forvia-core — Copyright (C) 2026 Duarte Santos and Nebula Systems.
forvia-core's own code is licensed under the **GNU AGPL v3.0** (see [LICENSE](LICENSE)).

## What this is

`forvia-core` is [Forvia](https://github.com/Nebula-Syst/Forvia)'s own core split into its own
service on 2026-09-19: authentication, sessions, account management, workout/routine/bodyweight/
nutrition-diary sync, the base admin panel, invite codes, bug reports, and the exercise-name
override list. This is the part of Forvia that is a direct continuation of
[**openGym**](https://gitlab.com/DuarteSantos8/opengym) by Duarte Santos, distributed under the
same AGPL v3.0 — auth, data sync and the base admin panel are still substantially that original
codebase's own commit history, carried forward. Forvia's own later additions (level/XP/prestige,
streaks, the social feed, and the coach/box system) are **not** in this repository — they're
Nebula Systems' own original work and live in the sibling service instead, which talks to this
one over a small internal API (see this service's `server.js` for exactly what crosses that
line, and why).

Nothing in this repository ships the exercise catalog, its images/animations, or the body-map
diagrams — those are frontend-bundle concerns Forvia's own frontend repository documents in its
own NOTICE.md. This backend only ever stores admin-authored exercise *name overrides* (plain
text corrections to how a name displays), which are Nebula's own content.

## App store exception

As an additional permission under section 7 of the AGPL v3.0, the copyright holder permits
distribution of the Forvia mobile application through app store platforms (such as the
Apple App Store and Google Play) whose terms of service would otherwise be incompatible
with the AGPL, provided the corresponding source code remains available under the AGPL at
the project repository. This permission applies to the distribution channel only and does
not otherwise limit the license.
