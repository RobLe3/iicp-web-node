# Browser compatibility

`@iicp/web-node` is tested locally against the Chromium, Firefox and WebKit
engines. The bounded test imports the released modules and checks runtime
identity context, Web Crypto confidentiality, dispatch-ticket verification and
cancellation without contacting the public IICP network.

WebGPU is reported separately. A browser can consume IICP routes even when it
cannot host a WebLLM model, and the absence of a usable GPU adapter is not a
protocol failure. Browser-provider mode remains experimental: headless engine
tests do not establish physical-device performance, tab-lifetime reliability,
relay availability or suitability for unattended workloads.

The evidence file classifies cancellation directly. OS-level tab suspension and
relay reconnect/binding remain untested because a headless package matrix cannot
reproduce them truthfully; they require a separate disposable relay and
representative-device lane. WebGPU denial or adapter absence is classified as
unsupported local execution rather than a failed IICP consumer.

Run the reproducible local matrix with:

```bash
npm run test:browsers
```

The dated result under `evidence/` records exact engine and package versions.
It is project-verified evidence, not independent browser certification.
