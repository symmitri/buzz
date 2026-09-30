type ProviderLogo = {
  name: string;
  light: string;
  dark?: string;
  monochrome?: boolean;
};

// Exact audited provider/connector IDs choose presentation only. Assets and
// licensing: public/connection-logos/CREDITS.md. Unknown/custom IDs stay neutral.
const brands: (ProviderLogo & { aliases?: string[] })[] = [
  {
    name: "google",
    light: "/connection-logos/google.svg",
    aliases: ["google-workspace"],
  },
  { name: "linear", light: "/connection-logos/linear.svg" },
  { name: "notion", light: "/connection-logos/notion.svg" },
  { name: "slack", light: "/connection-logos/slack.svg" },
  {
    name: "granola",
    light: "/connection-logos/granola-light.svg",
    dark: "/connection-logos/granola-dark.svg",
    aliases: ["granola-mcp", "granola-personal", "granola-workspace"],
  },
  {
    name: "github",
    light: "/connection-logos/github_light.svg",
    dark: "/connection-logos/github_dark.svg",
    aliases: ["github-app", "github-mine"],
  },
  {
    name: "vercel",
    light: "/connection-logos/vercel.svg",
    dark: "/connection-logos/vercel_dark.svg",
  },
  {
    name: "atlassian",
    light: "/connection-logos/atlassian.svg",
    aliases: ["jira", "confluence"],
  },
  { name: "asana", light: "/connection-logos/asana-logo.svg" },
  { name: "figma", light: "/connection-logos/figma.svg" },
  { name: "gitlab", light: "/connection-logos/gitlab.svg" },
  { name: "dropbox", light: "/connection-logos/dropbox.svg" },
  {
    name: "microsoft-365",
    light: "/connection-logos/microsoft.svg",
    aliases: ["microsoft", "microsoft-office"],
  },
  { name: "zoom", light: "/connection-logos/zoom.svg" },
  { name: "discord", light: "/connection-logos/discord.svg" },
  {
    name: "whatsapp",
    light: "/connection-logos/whatsapp-icon.svg",
    aliases: ["whatsapp-business"],
  },
  { name: "twilio", light: "/connection-logos/twilio.svg" },
  { name: "n8n", light: "/connection-logos/n8n.svg" },
  {
    name: "postgres",
    light: "/connection-logos/postgresql.svg",
    aliases: ["postgresql"],
  },
  {
    name: "mysql",
    light: "/connection-logos/mysql-icon-light.svg",
    dark: "/connection-logos/mysql-icon-dark.svg",
  },
  { name: "supabase", light: "/connection-logos/supabase.svg" },
  { name: "redis", light: "/connection-logos/redis.svg" },
  { name: "google-analytics", light: "/connection-logos/google-analytics.svg" },
  { name: "salesforce", light: "/connection-logos/salesforce.svg" },
  { name: "shopify", light: "/connection-logos/shopify.svg" },
  { name: "stripe", light: "/connection-logos/stripe.svg" },
  {
    name: "google-cloud",
    light: "/connection-logos/google-cloud.svg",
    aliases: ["gcp"],
  },
  { name: "azure", light: "/connection-logos/azure.svg" },
  {
    name: "aws",
    light: "/connection-logos/aws_light.svg",
    dark: "/connection-logos/aws_dark.svg",
  },
  { name: "cloudflare", light: "/connection-logos/cloudflare.svg" },
  { name: "kubernetes", light: "/connection-logos/kubernetes.svg" },
  { name: "datadog", light: "/connection-logos/datadog.svg" },
  { name: "sentry", light: "/connection-logos/sentry.svg", monochrome: true },
  {
    name: "firecrawl",
    light: "/connection-logos/firecrawl.svg",
    dark: "/connection-logos/firecrawl-dark.svg",
  },
  { name: "playwright", light: "/connection-logos/playwright.svg" },
  {
    name: "qdrant",
    light: "/connection-logos/qdrant-icon-light.svg",
    dark: "/connection-logos/qdrant-icon-dark.svg",
  },
  { name: "convex", light: "/connection-logos/convex.svg" },
  {
    name: "openrouter",
    light: "/connection-logos/openrouter_light.svg",
    dark: "/connection-logos/openrouter_dark.svg",
  },
  { name: "box", light: "/connection-logos/si-box.svg", monochrome: true },
  {
    name: "elastic",
    light: "/connection-logos/si-elastic.svg",
    monochrome: true,
    aliases: ["elasticsearch"],
  },
  {
    name: "bigquery",
    light: "/connection-logos/si-googlebigquery.svg",
    monochrome: true,
  },
  {
    name: "hubspot",
    light: "/connection-logos/si-hubspot.svg",
    monochrome: true,
  },
  {
    name: "imessage",
    light: "/connection-logos/si-imessage.svg",
    monochrome: true,
  },
  {
    name: "intercom",
    light: "/connection-logos/si-intercom.svg",
    monochrome: true,
  },
  { name: "make", light: "/connection-logos/si-make.svg", monochrome: true },
  {
    name: "quickbooks",
    light: "/connection-logos/si-quickbooks.svg",
    monochrome: true,
  },
  {
    name: "snowflake",
    light: "/connection-logos/si-snowflake.svg",
    monochrome: true,
  },
  { name: "xero", light: "/connection-logos/si-xero.svg", monochrome: true },
  {
    name: "zapier",
    light: "/connection-logos/si-zapier.svg",
    monochrome: true,
  },
  {
    name: "zendesk",
    light: "/connection-logos/si-zendesk.svg",
    monochrome: true,
  },
  {
    name: "lightfield",
    light: "/connection-logos/lightfield.svg",
    monochrome: true,
    aliases: ["lightfield-api", "lightfield-personal"],
  },
  { name: "ramp", light: "/connection-logos/ramp.svg", monochrome: true },
  { name: "exa", light: "/connection-logos/exa.svg", monochrome: false },
  {
    name: "context7",
    light: "/connection-logos/context7.svg",
    monochrome: false,
  },
  {
    name: "parallel",
    light: "/connection-logos/parallel.svg",
    monochrome: false,
    aliases: ["parallel-search"],
  },
  { name: "mercury", light: "/connection-logos/mercury.svg", monochrome: true },
  {
    name: "symmitri-os",
    light: "/symmitri-logomark.svg",
    monochrome: true,
    aliases: ["symmitri", "symmitri-os-personal"],
  },
  { name: "attio", light: "/connection-logos/attio.svg", monochrome: true },
  {
    name: "docusign",
    light: "/connection-logos/docusign.svg",
    monochrome: false,
  },
  {
    name: "langfuse",
    light: "/connection-logos/langfuse.svg",
    monochrome: true,
  },
  {
    name: "pinecone",
    light: "/connection-logos/pinecone.svg",
    monochrome: true,
  },
  {
    name: "pipedream",
    light: "/connection-logos/pipedream.png",
    monochrome: false,
  },
  { name: "tavily", light: "/connection-logos/tavily.svg", monochrome: false },
  {
    name: "weaviate",
    light: "/connection-logos/weaviate.svg",
    monochrome: false,
  },
  { name: "browserbase", light: "/connection-logos/browserbase.svg" },
  { name: "understudy", light: "/connection-logos/understudy.png" },
  { name: "gumloop", light: "/connection-logos/gumloop.png" },
];

export const connectionProviderLogos = new Map<string, ProviderLogo>(
  brands.flatMap(({ aliases = [], ...mark }) =>
    [mark.name, ...aliases].map((id) => [id, mark] as const),
  ),
);
