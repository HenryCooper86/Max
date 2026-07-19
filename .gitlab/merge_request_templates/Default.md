## Summary

Describe the user-visible outcome and the concrete problem being solved.

## Risk and rollback

- Risk level: low / medium / high
- Data or configuration migration:
- Rollback plan:

## Verification

- [ ] `npm run check`
- [ ] `npm audit --omit=dev`
- [ ] Android Debug and Release Kotlin compilation (when native code changes)
- [ ] iOS Debug and Release simulator builds (when native code changes)
- [ ] New behavior has regression coverage
- [ ] No credentials, `.env` files, private keys, or access tokens are included

## Delivery

- [ ] Source branch is up to date with `main`
- [ ] Required review is complete
- [ ] Merge to `main` before deploying; `deploy-lightsail.command` verifies local `HEAD` matches `origin/main`
