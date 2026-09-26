# apps/web

The DocuStamp web app. Vite + React 19 + TypeScript + Tailwind v4, talking to the existing Parse Server backend in `apps/server`.

```bash
cd apps/web
cp .env.example .env.local   # point VITE_DEV_PROXY_TARGET at your Parse server
npm install
npm run dev                  # http://localhost:3001
npm run build                # type-check + production build to dist/
```

Read `docs/CONVENTIONS.md` before adding code and `docs/BACKEND_API.md` for the backend contract.
