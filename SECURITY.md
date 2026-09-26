# Security policy

DocuStamp handles signed agreements, so security reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You should get a first reply within a few days. Once a fix is released, you will be credited in the release notes unless you prefer otherwise.

## Supported versions

Fixes land on the `main` branch and in the next release. Please check that the problem still exists on the latest `main` before reporting.

## Running your own server

A few settings matter most for a safe deployment (see `.env.example`):

- Use a long random `MASTER_KEY`, and set `FILE_TOKEN_SECRET` and `SIGNING_LINK_SECRET` to their own random values.
- Keep MongoDB off the public internet. The bundled `docker-compose.yml` only publishes it on the loopback interface.
- Set `MASTER_KEY_IPS` to the addresses that actually need the master key.
- Keep the server and its Docker images up to date.
