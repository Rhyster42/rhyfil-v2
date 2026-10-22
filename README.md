# Coffee POS

An offline-first point of sale for a coffee shop: a React PWA for the counter
tablets and a Go + PostgreSQL server.

Work in progress; see [docs/decisions](docs/decisions/) for the architecture.

## Run it

```sh
make up      # build and start Postgres + the app on http://localhost:8080
make test    # Go tests (against Postgres in Docker) and web tests
make help    # everything else
```
