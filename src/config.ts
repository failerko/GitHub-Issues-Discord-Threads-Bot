import dotenv from "dotenv";

// Loads .env from the *current working directory*, not from this file's
// directory. Values already present in the environment take precedence.
dotenv.config();

const REQUIRED_ENV_VARS = [
  "DISCORD_TOKEN",
  "DISCORD_CHANNEL_ID",
  "DISCORD_GUILD_ID",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_OWNER",
  "GITHUB_REPOSITORY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

// Report every missing variable at once so a misconfigured deployment can be
// fixed in a single pass instead of one restart per variable.
const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(
    `Missing environment variables: ${missing.join(", ")}\n` +
      "Set them in a .env file in the directory you run the bot from, or export them in the environment.",
  );
}

const env = process.env as Record<(typeof REQUIRED_ENV_VARS)[number], string>;

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }
  return value;
}

function toNumber(
  name: "GITHUB_APP_ID" | "GITHUB_APP_INSTALLATION_ID",
): number {
  return parsePositiveInt(name, env[name]);
}

// Optional: pin kanban sync to a specific GitHub Project by its number (the
// trailing number in the project URL). When unset, the first linked project
// that has a Status field is used, which is ambiguous once a repository has
// more than one project linked to it.
const projectNumber = process.env.GITHUB_PROJECT_NUMBER;

// The private key is stored base64-encoded. Decoding a raw PEM instead of its
// base64 form yields garbage that only fails much later, on the first API call.
function decodePrivateKey(): string {
  const decoded = Buffer.from(env.GITHUB_APP_PRIVATE_KEY, "base64").toString(
    "utf8",
  );
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY did not decode to a PEM private key. " +
        "It must be the base64 encoding of the .pem file (e.g. `base64 -w0 key.pem`).",
    );
  }
  return decoded;
}

export const config = {
  DISCORD_TOKEN: env.DISCORD_TOKEN,
  GITHUB_APP_ID: toNumber("GITHUB_APP_ID"),
  GITHUB_APP_PRIVATE_KEY: decodePrivateKey(),
  GITHUB_APP_INSTALLATION_ID: toNumber("GITHUB_APP_INSTALLATION_ID"),
  GITHUB_OWNER: env.GITHUB_OWNER,
  GITHUB_REPOSITORY: env.GITHUB_REPOSITORY,
  GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
  DISCORD_CHANNEL_ID: env.DISCORD_CHANNEL_ID,
  DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
  GITHUB_PROJECT_NUMBER: projectNumber
    ? parsePositiveInt("GITHUB_PROJECT_NUMBER", projectNumber)
    : undefined,
};
