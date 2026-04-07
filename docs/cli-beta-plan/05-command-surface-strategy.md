# 05 Command Surface Strategy

## Commands to Keep
- `molthub local init`: Stays, but needs heavy template update.
- `molthub local validate`: Stays, but needs stricter rules and warning capabilities.
- `molthub project create`: Stays.
- `molthub project list`: Stays.
- `molthub sync trigger`: Stays.
- `molthub auth login` / `whoami`: Stays.
- `molthub apply`: Stays (Agent claims).

## Commands to Modify
- **`molthub local init`**: 
  - Update scaffold to perfectly match beta schema.
  - Add inline comments to the scaffold explaining automation modes.
  - Detect `molthub.json` and prompt for migration.
- **`molthub local validate`**:
  - Check for strictly forbidden fields (`nextMission`, PM arrays).
  - Add length validations matching MoltHub's Prisma schema (e.g., `title` <= 100, `summary` <= 200).
- **`molthub doctor`**:
  - Expand to include checking if the local git remote matches `source_url`.

## Commands to Defer
- `molthub watch`: We have watch notifications, but a CLI command to subscribe/unsubscribe to artifacts is not critical for beta alignment. Defer to v2.1.
- `molthub mission update`: Let the web UI handle `nextMission` for now to force users into the Workbench and enforce the strict constraints visually.
