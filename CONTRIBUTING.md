# Contributing

Use this repository's issue forms for reproducible browser-node defects and
documentation problems. Use the public IICP specification repository for
protocol or cross-component proposals, the IICP forum for open-ended
discussion, and GitHub's private security-advisory form for vulnerabilities.

Do not include credentials, private topology, production records, task
payloads or personal data in public issues. Participation does not confer
protocol authority; public proposal decisions remain recorded in the owning
issue or pull request under the current founder-led governance process.

Keep changes within the experimental browser-node boundary. Protocol changes
must first be accepted in the IICP specification repository. Run the package's
quality checks before opening a pull request and include a content-free
reproduction for behavior changes.

## Reproducing the checks

From a clean checkout with the Node version used by the quality workflow:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:audit
```

The public [IICP repository map](https://github.com/RobLe3/IICP/blob/main/ecosystem/public-repositories.json)
identifies normative and implementation ownership. The browser node is an
experimental Web implementation and is not evidence for native raw-TCP
framing. A pull request does not authorize a package release or deployment.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
