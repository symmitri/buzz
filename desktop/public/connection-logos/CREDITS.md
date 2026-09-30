# Connection logo provenance

These local assets identify the corresponding service; they do not advertise
availability, endorsement or account authority. Brand names and marks belong to
their owners. No logo service is called at runtime. Unknown providers use a
neutral integration glyph beside their readable name.

Coverage was audited against Axis `packages/control-plane/src/integrations.ts`
(65 entries), `connection-roadmap.ts`, and Gateway connector/provider identifiers.
67 brand mappings cover every researched catalog entry and the named roadmap
services. Planned entries are never inserted into the employee catalog by this UI.

## Libraries

- [SVGL](https://svgl.app), MIT © 2022 Pablo Hdez; source pinned to
  [`b49649915224db817b89ff400b940a2a93bdb3d3`](https://github.com/pheralb/svgl/tree/b49649915224db817b89ff400b940a2a93bdb3d3/static/library).
  Upstream filenames and geometry are unchanged. Supplied light/dark variants
  are used when available; the single-color Sentry mark is inverted in dark mode.
- [Simple Icons 16.27.1](https://simpleicons.org), CC0-1.0 path data; source pinned
  to [`7dd8ec97c57a3c060d50d4c414491c0b64e4e857`](https://github.com/simple-icons/simple-icons/tree/7dd8ec97c57a3c060d50d4c414491c0b64e4e857/icons).
  `si-` prefixes are local filenames. Unchanged monochrome SVGs invert in dark
  mode. [CC0 dedication](https://github.com/simple-icons/simple-icons/blob/7dd8ec97c57a3c060d50d4c414491c0b64e4e857/LICENSE.md).
- [theSVG](https://thesvg.org), MIT © 2025 thesvg.org; source pinned to
  [`51d069ec79f21430299176d5df44d39c81ebd32d`](https://github.com/glincker/thesvg/tree/51d069ec79f21430299176d5df44d39c81ebd32d/public/icons).
  Attio, DocuSign badge, Langfuse mono, Pinecone mono, Tavily color, and Weaviate
  use the supplied geometry. Weaviate's empty canvas is trimmed from 122×18 to
  30×18 around its supplied symbol. Attio, Langfuse and Pinecone invert in dark mode.

| Bundled file(s) | Library / source path |
|---|---|
| `google.svg` | SVGL `static/library/` |
| `linear.svg` | SVGL `static/library/` |
| `notion.svg` | SVGL `static/library/` |
| `slack.svg` | SVGL `static/library/` |
| `granola-light.svg`, `granola-dark.svg` | SVGL `static/library/` |
| `github_light.svg`, `github_dark.svg` | SVGL `static/library/` |
| `vercel.svg`, `vercel_dark.svg` | SVGL `static/library/` |
| `atlassian.svg` | SVGL `static/library/` |
| `asana-logo.svg` | SVGL `static/library/` |
| `figma.svg` | SVGL `static/library/` |
| `gitlab.svg` | SVGL `static/library/` |
| `dropbox.svg` | SVGL `static/library/` |
| `microsoft.svg` | SVGL `static/library/` |
| `zoom.svg` | SVGL `static/library/` |
| `discord.svg` | SVGL `static/library/` |
| `whatsapp-icon.svg` | SVGL `static/library/` |
| `twilio.svg` | SVGL `static/library/` |
| `n8n.svg` | SVGL `static/library/` |
| `postgresql.svg` | SVGL `static/library/` |
| `mysql-icon-light.svg`, `mysql-icon-dark.svg` | SVGL `static/library/` |
| `supabase.svg` | SVGL `static/library/` |
| `redis.svg` | SVGL `static/library/` |
| `google-analytics.svg` | SVGL `static/library/` |
| `salesforce.svg` | SVGL `static/library/` |
| `shopify.svg` | SVGL `static/library/` |
| `stripe.svg` | SVGL `static/library/` |
| `google-cloud.svg` | SVGL `static/library/` |
| `azure.svg` | SVGL `static/library/` |
| `aws_light.svg`, `aws_dark.svg` | SVGL `static/library/` |
| `cloudflare.svg` | SVGL `static/library/` |
| `kubernetes.svg` | SVGL `static/library/` |
| `datadog.svg` | SVGL `static/library/` |
| `sentry.svg` | SVGL `static/library/` |
| `firecrawl.svg`, `firecrawl-dark.svg` | SVGL `static/library/` |
| `playwright.svg` | SVGL `static/library/` |
| `qdrant-icon-light.svg`, `qdrant-icon-dark.svg` | SVGL `static/library/` |
| `convex.svg` | SVGL `static/library/` |
| `openrouter_light.svg`, `openrouter_dark.svg` | SVGL `static/library/` |
| `si-box.svg` | Simple Icons `icons/box.svg` |
| `si-elastic.svg` | Simple Icons `icons/elastic.svg` |
| `si-googlebigquery.svg` | Simple Icons `icons/googlebigquery.svg` |
| `si-hubspot.svg` | Simple Icons `icons/hubspot.svg` |
| `si-imessage.svg` | Simple Icons `icons/imessage.svg` |
| `si-intercom.svg` | Simple Icons `icons/intercom.svg` |
| `si-make.svg` | Simple Icons `icons/make.svg` |
| `si-quickbooks.svg` | Simple Icons `icons/quickbooks.svg` |
| `si-snowflake.svg` | Simple Icons `icons/snowflake.svg` |
| `si-xero.svg` | Simple Icons `icons/xero.svg` |
| `si-zapier.svg` | Simple Icons `icons/zapier.svg` |
| `si-zendesk.svg` | Simple Icons `icons/zendesk.svg` |
| `attio.svg` | theSVG `public/icons/attio/default.svg` |
| `docusign.svg` | theSVG `public/icons/docusign-badge/default.svg` |
| `langfuse.svg` | theSVG `public/icons/langfuse/mono.svg` |
| `pinecone.svg` | theSVG `public/icons/pinecone/mono.svg` |
| `tavily.svg` | theSVG `public/icons/tavily/color.svg` |
| `weaviate.svg` | theSVG `public/icons/weaviate/default.svg` |

## Reused Axis artwork and official sources

| Asset | Provenance and license / use | Adaptation |
|---|---|---|
| `lightfield.svg` | Existing `packages/control-plane/src/assets/connections/lightfield.svg`; [official Lightfield site artwork](https://cdn.sanity.io/images/3ccg9tet/production/9bda0a3065e88d43b923ca35890768090a36fb8d-19x16.svg) | Geometry unchanged; dark inversion |
| `ramp.svg` | Existing Gateway `assets/connections/ramp.svg`; Ramp trademark | Geometry unchanged; dark inversion |
| `exa.svg` | Existing Gateway `assets/connections/exa.svg`, synced from Iconify `thesvg-color:exa`; theSVG MIT | None |
| `context7.svg` | Existing Gateway `assets/connections/context7.svg`, synced from Iconify `vscode-icons:file-type-context7`; MIT © 2016 Roberto Huertas | None |
| `parallel.svg` | Existing Gateway asset; [official Parallel icon](https://parallel.ai/icon.svg?icon.1d0de8d5.svg) | None; supplied white background |
| `mercury.svg` | Existing Gateway asset; [official Mercury icon](https://mercury.com/icon.svg?9c0dadf0c8dee356) | Removed system-theme media rule; app theme controls dark inversion |
| `/symmitri-logomark.svg` | Existing Spaces Alpha official Symmitri symbol, copied by preparation from Axis brand artwork | Geometry unchanged; dark inversion |
| `understudy.png` | Existing Gateway official Understudy asset, originally from `https://understudylabs.com/icon?27b5acef1c37cb41` | Preparation reuses existing Axis bytes; no duplicate raster in the patch |
| `browserbase.svg` | [Official Browserbase favicon](https://www.browserbase.com/favicon.svg), retrieved 2026-09-17 | None |
| `gumloop.png` | [Official Gumloop favicon](https://www.gumloop.com/favicon.ico), retrieved 2026-09-17 | Original embedded 32×32 PNG extracted without redrawing or re-encoding |
| `pipedream.png` | [Official Pipedream favicon](https://pipedream.com/assets/favicon.svg), retrieved 2026-09-17 | Original embedded 600×600 PNG extracted without redrawing or re-encoding |

The official vendor assets above are used to identify their own services, following
existing Gateway and Buzz brand-asset practice. No separate open artwork license
is recorded for them; they are not represented as covered by the library MIT/CC0
licenses. Understudy is kept as the existing Understudy identifier rather than
substituting the brand at its website's later redirect.

## MIT notices

Copyright (c) 2022 Pablo Hdez (SVGL)

Copyright (c) 2025 thesvg.org (theSVG)

Copyright (c) 2016 Roberto Huertas (VSCode Icons)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
