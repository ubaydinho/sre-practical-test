# Coffee Orders - SRE Practical Test (Section 3)

Small app to practice the things in the test: JWT login, CRUD API, database, logging, health check, and a simple alert simulation. Data comes from Sample APIs (coffee, hot).

Stack: Node.js + Express, SQLite, JWT, plain HTML/JS for the frontend, Docker.

## How to run

With Docker:

```bash
docker compose up --build
```

Or with Node (version 18+):

```bash
npm install
npm start
```

Open http://localhost:3000. Default login is `admin` / `admin123`. Before running, set `JWT_SECRET` and `ADMIN_PASSWORD` as environment variables (in docker-compose.yml for Docker).

## How to use

1. Login.
2. Click "Sync dari Sample API". The coffee list is fetched and saved into my own database.
3. Click "+ Order Baru" to make a transaction. The status can be changed from the dropdown, and an order can be deleted.
4. The Alerts panel has two buttons to simulate a 5xx burst and a slow response.

## Database

- `coffees` is the master table (from Sample API).
- `orders` is the transaction table. Each order points to a coffee and a user, and the total is calculated by the backend.
- `users` is for login. Passwords are saved as bcrypt hash.

## API

Everything under `/api` needs `Authorization: Bearer <token>`, except login and register.

| Method | Path | Note |
|---|---|---|
| GET | /health | no token, checks the database |
| POST | /api/auth/login, /api/auth/register | get the token here |
| POST | /api/sync | fetch from Sample API and save to DB |
| GET, POST | /api/coffees | list and add |
| GET, PUT, DELETE | /api/coffees/:id | |
| GET, POST | /api/orders | list and create |
| GET, PUT, DELETE | /api/orders/:id | |
| GET | /api/summary, /api/alerts | numbers and alerts for the dashboard |

Responses are JSON with proper status codes: 201 created, 204 deleted, 400 bad JSON, 401 no or wrong token, 404 not found, 409 conflict, 422 validation failed, 500 server error. Input is validated before it goes to the database.

## Logging

Logs are JSON, one per line, saved in the `logs` folder (and also shown in the console):

- `access.log`: method, endpoint, status, response time
- `transaction.log`: sync, order created, updated, deleted
- `error.log`: server errors with stack trace, failed calls to Sample API, and alerts

To read them in Docker:

```bash
docker compose exec app tail -f /logs/access.log
```

## Monitoring and alert

- `/health` returns 200 when the app and DB are fine, 503 when the DB is not. The Dockerfile uses it for HEALTHCHECK.
- HighErrorRate: more than 3 errors (5xx) in 60 seconds. Test it with `/debug/error` 4 times, or use the button on the dashboard.
- SlowResponse: a response slower than 1000 ms (change with `SLOW_MS`). Test it with `/debug/slow`.
- Alerts are written to `error.log` and shown in the dashboard.
- Errors are handled in one place, so the API always answers with JSON and not a crash. The call to Sample API has an 8 seconds timeout. If Sample API can't be reached, the app uses 3 fallback items and writes it in the error log. On SIGTERM the app closes the server and the database first.

## Notes

- I used SQLite because it is simple for this test. For a real system I would use PostgreSQL.
- Alerts are only simulated inside the app (in memory). In production I would send the metrics to Prometheus and use Alertmanager.
- `/debug/error` and `/debug/slow` have no login, only for testing. They should be removed or protected in production.
- The sync can take more than 1 second because it calls an external API, so it can also trigger the SlowResponse alert. This is expected.
