# Reglas del proyecto

## Ramas

- `main` es **producción** (lo público). `develop` es **desarrollo**.
- Todo el trabajo se sube a `develop`. Nunca se hace commit ni push directo a `main`.
- Para publicar: pull request de `develop` → `main`, solo cuando el CI (`pnpm check`, `pnpm test`, `pnpm build`, e2e) está en verde en `develop` y la funcionalidad está comprobada.
- Las dos ramas están protegidas en GitHub: no se pueden borrar ni reescribir (sin force push). `main` solo acepta PR con el CI aprobado.

## Gestor de paquetes

pnpm (versión fijada en `packageManager`). Ojo: `pnpm --filter @jaque/worker run deploy`, con `run`.
