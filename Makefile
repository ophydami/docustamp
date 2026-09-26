# Local stack. `make build` brings the whole thing up from this checkout:
# docker-compose.yml builds the one image (the root Dockerfile builds the web
# app and the server together), so there is no host-side npm build step here.
build:
	@echo "Building with HOST_URL=${HOST_URL}"
	cp .env.local_dev .env
	[ -f .env.prod ] || cp .env.local_dev .env.prod
	HOST_URL=${HOST_URL} docker compose up --build --force-recreate

run:
	@echo "Running with HOST_URL=${HOST_URL}"
	cp .env.local_dev .env
	[ -f .env.prod ] || cp .env.local_dev .env.prod
	HOST_URL=${HOST_URL} docker compose up -d

down:
	docker compose down
