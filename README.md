# Tournament Genie

A Discord bot and website for running a store's day of Play! Pokémon events. It creates fresh,
staff-only Discord channels for the day in one click, takes penalties through `/penalty`, exports each
tournament's penalty CSV for the head judge, and cleans the channels up afterwards. It can import the
day's tournaments and staff from
[play-pokemon-attendance-web](https://github.com/Towerism/play-pokemon-attendance-web).

Design (accepted 2026-10-13): [`docs/architecture/`](docs/architecture/README.md).
Its platform infrastructure (vault, secret bootstrap, logging, security middleware, Docker assets, image
and release workflows) is to come from the shared
[`@towerism/selfhost-kit`](https://github.com/Towerism/selfhost-kit) (proposed in ADR-0011).
