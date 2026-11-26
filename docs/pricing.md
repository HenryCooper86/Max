# Pricing and licensing

Max is free and open source. You pay only if you want us to run it for you, or to have us on call. The same three
plans are on the website at `/pricing`.

| Plan            | Price                                                                                  | What you get                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Open source** | Free, forever                                                                          | Everything in this repository, self-hosted on your own server or with Docker. Every voice backend, tools, the SDK and the widget.    |
| **Max Cloud**   | ¥0.15 (about $0.02) per minute, first 1,000 minutes every month free. _By invitation._ | We run the relay: TLS and updates. You bring your own OpenAI, Gemini or xAI key, and model costs go straight to them.                |
| **Enterprise**  | Custom, annual agreement                                                               | Priority support with an SLA, help deploying on your own infrastructure, custom tools and integrations, security review, onboarding. |

Max Cloud is by invitation during early access. To ask for an invitation, add balance or talk about Enterprise, email
[henry.cooper86@gmail.com](mailto:henry.cooper86@gmail.com).

## The license

Max is [MIT licensed](../LICENSE). You can use it, change it, and sell products built on it, with no fee and no
obligation to publish your changes. Keep the copyright and license notice with the code. Nothing in the self-hosted kit
is locked or time-limited, and the paid plans add services, not features.

## Questions

**What counts as a minute?** The time a voice session is connected, billed by the second. A 90-second session is 1.5
minutes. Typed messages and tool calls in that session are included.

**Why bring my own model key?** Your model costs go straight to your provider at their prices. Our fee covers hosting
only: no markup, no surprises, and switching models never changes our price.

**Can I move between Cloud and self-hosting?** Yes, in both directions. The SDK and the protocol are the same, so
your pages and apps change only the relay URL. What mints their session tokens changes too: a self-hosted relay takes
its `RELAY_AUTH_TOKEN`, Max Cloud a project key (`mpk_…`), and a project's settings are set again on the other side.

**Does Max Cloud include Max Speech?** No. [Max Speech](speech-server-deployment.md) runs on your own hardware, so it
comes with self-hosting, free. Max Cloud uses your OpenAI, Gemini or xAI key.

**Can I charge my own customers?** Yes. A self-hosted relay counts voice minutes per user, can cap them, and can send
each session's usage to your billing system. Max Cloud counts and caps minutes per project. See
[usage and billing](usage-and-billing.md).

**Do I need to tell you I am using Max?** No. We are always glad to hear about it, by email or in GitHub Discussions.
