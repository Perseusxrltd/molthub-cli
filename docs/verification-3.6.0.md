# MoltHub CLI 3.6.0 candidate verification

Verified locally on 2026-09-13, Windows, Node.js 25.2.1, npm 11.6.2.

Rechecked September 21 after the prepared-proof fix: all 107 tests in 10 files, the TypeScript build, package dry run, and a fresh runtime-only package installation smoke passed. Final logs and the tarball are under `C:\tmp\molthub-upgrade-2026-09-13\cli-sept21-prefilled-proof-103541`. The earlier September 21 full dependency audit passed with zero reported vulnerabilities; dependency manifests are unchanged by this fix. The package is still unpublished.

| Check | Result |
| --- | --- |
| TypeScript build | Passed |
| Full test suite | 107 tests in 10 files passed |
| Full dependency audit | Zero vulnerabilities; initial lockfile had nine |
| Production dependency audit | Zero vulnerabilities |
| Git whitespace check | Passed |
| npm package dry run | Passed; 18 declared package files, no test fixtures or keys |
| Packed tarball installation | Passed in a disposable directory with only runtime dependencies and install scripts disabled |
| Installed binary | Reported 3.6.0; JSON command manifest parsed successfully and included doctor |
| Installed manual proof workflow | Prepared identity fields matched run metadata; filling only the actual result and checks validated without collection; incomplete results and changed checksums were rejected; submit dry run created no receipt |
| Web/CLI source-contract review | Evidence fields, proof modes, completion limits, receipt shapes, and review-draft distinction aligned with the coordinated web changes |

The full suite exercises the built executable, local HTTP servers, disposable Git repositories, failed completion after successful proof submission, scope-denial responses, unusual paths, malformed proof, linked run folders, secret filtering, committed/staged/unstaged proof, and offline JSON behavior. Prepared proof now includes the exact mission ID, packet checksum, and selected executor while all result, check, and repository proof fields remain blank. Regression coverage verifies manual editing without collection and rejects metadata line injection before writing a run. Checksum mismatch enforcement is unchanged. Unit and integration assertions passed; test deadlines were increased for Windows subprocess startup under concurrent development load, and worker concurrency is bounded to two.

The final package smoke tarball contained 252,024 unpacked bytes across 18 declared files (57,085 compressed bytes). Its npm SHA-1 was `d1db1304f060d108941b1f7e98a74be354aa9d3c`. The dry-run package and actual tarball hashes matched. The disposable installation omitted development dependencies and disabled installation scripts; its binary validated the new manual-proof path and rejected a changed checksum. This is a locally generated candidate, not an npm release.

The new GitHub Actions workflow is configured for Node 22 on Linux and Windows and runs on pull requests or pushes to master. No remote CI result is included in this local verification. Node 18 compatibility remains the existing declared runtime floor; this local verification used Node 25 and does not establish a fresh Node 18 runtime test.

Engine metadata review: all 35 installed production dependencies declare either no Node engine restriction or a range compatible with Node 18. Commander 12.1.0 has the highest explicit runtime floor (`>=18`). The updated Axios 1.20.0 and js-yaml 4.3.2 packages do not declare a Node engine restriction; fs-extra 11.4.0 requires `>=14.14`, and Chalk 5.6.2 accepts Node 16 and later. No production-engine mismatch requires changing package.json or its lock metadata.

Development tooling has a higher floor: Vitest 4.1.11 accepts Node 20, Node 22, and Node 24+, while its locked Vite 8.3.0/Rolldown 1.2.8 dependencies require Node 20.19+ or Node 22.12+. Use Node 22.12+ within the Node 22 release line, or Node 24+, for a full developer install and test run. The workflow's `node-version: 22` resolves a current Node 22 release satisfying this floor. This verification document is not included in the package.

No authenticated production calls, npm publication, or release tag was performed. Real production credentials, deployed endpoint compatibility, and owner-review flows remain release gates. Optional `manual`/`no_repo` proof modes depend on the coordinated server update. Older run folders without preparation commits cannot reconstruct committed changes automatically; collection reports that limitation.
