// The types every Worker module shares: what the Worker is given, and its one log line per request.

// What the Worker is given: the database and its settings (wrangler.jsonc vars, plus Worker secrets).
export type Env = {
	DB: D1Database;
	// Access's team address, "https://still-garden.cloudflareaccess.com": the token's issuer, and where its keys are,
	// at /cdn-cgi/access/certs. Tests point it at a stand-in.
	ACCESS_TEAM_DOMAIN: string;
	// The Application Audience tag of the Access app guarding /liminal-space/api/sync.
	SYNC_AUD: string;
	// The client ID of Access service token "sync": a sync token's "common_name" claim. A Worker secret.
	SYNC_CLIENT_ID: string;
	// How long, in seconds, the Worker waits before fetching Access's keys again for an unknown key id. Default 60.
	JWKS_COOLDOWN_SECONDS?: string;
	// The Application Audience tag of the Access app "owner", guarding the owner's page and API.
	OWNER_AUD: string;
	// The owner's login email: an owner token's "email" claim. A Worker secret, never in the repo.
	OWNER_EMAIL: string;
	// The site's own origin, "https://ivan.wiryadi.com": a POST to an owner route must carry it as Origin.
	SITE_ORIGIN: string;
	// A fine-grained GitHub token with Actions write on this repository only, for dispatching workflows. A Worker secret.
	GITHUB_DISPATCH_TOKEN: string;
	// "strivn/liminal-space": the repository whose workflows the Worker dispatches.
	GITHUB_REPOSITORY: string;
	// GitHub's API, "https://api.github.com". Tests point it at a stand-in.
	GITHUB_API: string;
	// The Application Audience tag of the Access app "mcp", guarding /liminal-space/mcp with Managed OAuth.
	// A Worker secret, never in the repo: unlike the other two tags, Access publishes it nowhere.
	MCP_AUD: string;
	// Anthropic's API, "https://api.anthropic.com". Tests point it at a stand-in.
	ANTHROPIC_API: string;
	// The key of the Console workspace that pays for Claude's replies. A Worker secret; staging has none, so its ask
	// route answers "notSetUp".
	ANTHROPIC_API_KEY?: string;
	// The VAPID key pair the Worker signs pushes with, as base64url text: the public half is what the
	// page subscribes with. Worker secrets, absent on staging: without both, the Worker takes no subscription and sends
	// no notification. The private key is never logged or answered.
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	// Where pushes go instead of each subscription's own push service: the same path on this origin. Tests point it at a
	// stand-in, as they do GITHUB_API; it is set nowhere else.
	PUSH_SERVICE_ORIGIN?: string;
	// How many milliseconds the Worker waits for one push before giving up on that device; default 5000. Tests shorten it.
	PUSH_TIMEOUT_MS?: string;
};

// The one log line per request, written with console.log as JSON. Tests read it; in production it is Workers Logs.
// queries counts every D1 statement the request ran (a batch counts each statement); rowsRead and rowsWritten sum
// D1's meta.rows_read and meta.rows_written over them. reason says why a request was refused, or what failed in an
// answered one (an add run that couldn't be dispatched), never a token's text.
export type RequestLog = {
	method: string;
	path: string;
	status: number;
	reason?: string;
	queries: number;
	rowsRead: number;
	rowsWritten: number;
};
