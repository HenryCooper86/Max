# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue or pull request.

Use GitHub's private vulnerability reporting at
<https://github.com/HenryCooper86/Max/security/advisories/new> (the repository's **Security** tab, **Report a
vulnerability**). This creates a private security advisory that only the maintainers can see.

Please include:

- what the problem is and which part is affected (relay, SDK, a device client, the Docker image),
- the commit or version you tested,
- steps to reproduce, or a proof of concept,
- the impact you expect.

You can expect an acknowledgement within a few working days, and updates as we investigate. We will agree a fix and a
disclosure date with you, and credit you in the advisory if you want that.

## Supported versions

Only the `main` branch is supported. Fixes land on `main`. If you run a fork or an older copy, update to the latest
`main` before reporting.

## Scope

In scope: the relay (`server/`), the browser SDK (`sdk/`), the protocol, the reference clients in `examples/`, the
Dockerfile and the deployment documentation.

Out of scope: problems in the third-party voice services the relay connects to, and findings that need a leaked secret
you were not given. Reports about a deployment you run yourself, such as an exposed relay without `RELAY_AUTH_TOKEN`, are
configuration issues; see [docs/security.md](docs/security.md).

For how the relay protects keys, tokens and tools, read [docs/security.md](docs/security.md).
