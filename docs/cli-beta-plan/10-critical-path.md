# 10 Critical Path

The safest execution order minimizes user confusion and ensures that the core behavior is correct before updating the documentation that relies on it.

1. **WS-3 (Legacy Migration) & WS-2 (Scaffold Hardening):** 
   - Implement the new scaffold template and validation rules first. This sets the technical baseline.
2. **WS-4 (Command Output Terminology):** 
   - Update terminal output to match the new reality and the new template comments.
3. **WS-1 (Documentation Alignment):** 
   - Finally, rewrite `SKILL.md` and `README.md` so they document the newly updated commands and accurately reflect the beta website.

*All workstreams can be merged incrementally, but WS-1 must be the final release bow.*
