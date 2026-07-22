import {
  ChannelType,
  ChatInputCommandInteraction,
  Collection,
  ForumChannel,
  Message,
  PermissionFlagsBits,
  PublicThreadChannel,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "../config";
import {
  createIssue,
  createIssueComment,
  getIssue,
  getIssueComments,
} from "../github/githubActions";
import { logger } from "../logger";
import { store } from "../store";
import {
  archiveThread,
  createComment,
  createThread,
  enrichThreadAfterIssueCreation,
  fallbackTagId,
  lockThread,
} from "./discordActions";
import client from "./discord";

const syncIssueCommand = new SlashCommandBuilder()
  .setName("sync-issue")
  .setDescription(
    "Create a Discord thread from an existing GitHub issue and replay its comments",
  )
  .addStringOption((option) =>
    option
      .setName("issue")
      .setDescription(
        "GitHub issue number or URL (e.g. 42 or https://github.com/owner/repo/issues/42)",
      )
      .setRequired(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads);

const syncThreadCommand = new SlashCommandBuilder()
  .setName("sync-thread")
  .setDescription(
    "Create a GitHub issue from this forum thread and replay all messages as comments",
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads);

export async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, config.DISCORD_GUILD_ID),
      {
        body: [syncIssueCommand.toJSON(), syncThreadCommand.toJSON()],
      },
    );
    logger.info("Slash commands: Registered /sync-issue, /sync-thread");
  } catch (err) {
    logger.error(
      `Slash commands: Failed to register: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export function parseIssueInput(input: string): number | null {
  // Try plain number
  const asNumber = Number(input);
  if (Number.isInteger(asNumber) && asNumber > 0) return asNumber;

  // Try GitHub URL: https://github.com/owner/repo/issues/N
  const urlRegex =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;
  const match = input.match(urlRegex);
  if (!match) return null;

  const [, owner, repo, num] = match;
  if (
    owner.toLowerCase() !== config.GITHUB_OWNER.toLowerCase() ||
    repo.toLowerCase() !== config.GITHUB_REPOSITORY.toLowerCase()
  ) {
    return null; // Wrong repo
  }

  return Number(num);
}

function resolveAppliedTags(
  labels: { name: string }[],
  issueTypeName?: string,
): string[] {
  const appliedTags = (labels || [])
    .map((label) => store.tagMap.get(label.name))
    .filter((tagId): tagId is string => tagId !== undefined)
    .slice(0, 5);

  if (issueTypeName) {
    const typeTagId = store.tagMap.get(issueTypeName);
    if (
      typeTagId &&
      !appliedTags.includes(typeTagId) &&
      appliedTags.length < 5
    ) {
      appliedTags.push(typeTagId);
    }
  }

  if (appliedTags.length === 0) {
    const fallback = fallbackTagId();
    if (fallback) {
      appliedTags.push(fallback);
    }
  }

  return appliedTags;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleSyncIssueCommand(
  interaction: ChatInputCommandInteraction,
) {
  await interaction.deferReply({ ephemeral: true });

  const input = interaction.options.getString("issue", true);
  const issueNumber = parseIssueInput(input);

  if (!issueNumber) {
    await interaction.editReply(
      "Invalid input. Provide a GitHub issue number or a URL like `https://github.com/owner/repo/issues/42`.",
    );
    return;
  }

  // Check if thread already exists
  const existing = store.threads.find((t) => t.number === issueNumber);
  if (existing) {
    await interaction.editReply(
      `Issue #${issueNumber} is already synced: <#${existing.id}>`,
    );
    return;
  }

  // Fetch issue from GitHub
  await interaction.editReply(`Fetching issue #${issueNumber} from GitHub...`);
  const issue = await getIssue(issueNumber);

  if (!issue) {
    await interaction.editReply(`Issue #${issueNumber} was not found.`);
    return;
  }

  // Guard against PRs (GitHub treats PRs as issues in the API)
  if (issue.pull_request) {
    await interaction.editReply(
      `#${issueNumber} is a pull request, not an issue.`,
    );
    return;
  }

  // Resolve tags from labels and issue type
  const appliedTags = resolveAppliedTags(
    issue.labels.filter(
      (l): l is { name: string } =>
        typeof l !== "string" && "name" in l && typeof l.name === "string",
    ),
    (issue as any).type?.name,
  );

  // Create Discord thread
  await interaction.editReply(`Creating thread for issue #${issueNumber}...`);
  await createThread({
    body: issue.body || "",
    login: issue.user?.login || "unknown",
    title: issue.title,
    appliedTags,
    node_id: issue.node_id,
    number: issue.number,
  });

  // Find the newly created thread in store
  const thread = store.threads.find((t) => t.node_id === issue.node_id);
  if (!thread) {
    await interaction.editReply(
      `Failed to create thread for issue #${issueNumber}.`,
    );
    return;
  }

  // Fetch and replay comments
  const comments = await getIssueComments(issueNumber);
  const filteredComments = comments.filter(
    (c) => !c.body?.includes("discord.com/channels/"),
  );

  if (filteredComments.length > 0) {
    await interaction.editReply(
      `Replaying ${filteredComments.length} comment(s)...`,
    );

    for (const comment of filteredComments) {
      await createComment({
        git_id: comment.id,
        body: comment.body || "",
        login: comment.user?.login || "unknown",
        avatar_url:
          comment.user?.avatar_url ||
          "https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png",
        node_id: issue.node_id,
      });
      await delay(1000);
    }
  }

  // Archive if closed, lock if locked
  if (issue.state === "closed") {
    await archiveThread(issue.node_id);
  }
  if (issue.locked) {
    await lockThread(issue.node_id);
  }

  await interaction.editReply(
    `Synced issue #${issueNumber} with ${filteredComments.length} comment(s): <#${thread.id}>`,
  );
}

async function fetchAllMessages(
  fetchFn: (options: {
    limit: number;
    before?: string;
  }) => Promise<Collection<string, Message>>,
): Promise<Message[]> {
  const all: Message[] = [];
  let before: string | undefined;

  while (true) {
    const options: { limit: number; before?: string } = { limit: 100 };
    if (before) options.before = before;

    const batch = await fetchFn(options);
    if (batch.size === 0) break;

    all.push(...batch.values());
    before = batch.last()!.id;

    if (batch.size < 100) break;
  }

  // Discord returns newest-first; reverse to chronological order
  return all.reverse();
}

export async function handleSyncThreadCommand(
  interaction: ChatInputCommandInteraction,
) {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;

  // Validate: must be inside a forum thread
  if (
    !channel ||
    !channel.isThread() ||
    channel.type !== ChannelType.PublicThread
  ) {
    await interaction.editReply(
      "This command must be run inside a forum thread.",
    );
    return;
  }

  const isMainForum = channel.parentId === config.DISCORD_CHANNEL_ID;

  // For main forum threads, check if already linked
  if (isMainForum) {
    const thread = store.threads.find((t) => t.id === channel.id);
    if (!thread) {
      await interaction.editReply(
        "This thread is not tracked. Try creating a new post in the forum.",
      );
      return;
    }

    if (thread.number) {
      const issueUrl = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPOSITORY}/issues/${thread.number}`;
      await interaction.editReply(
        `This thread is already linked to issue #${thread.number}: ${issueUrl}`,
      );
      return;
    }

    return await syncMainForumThread(interaction, channel, thread);
  }

  // Non-main forum: create both a GitHub issue and a Discord thread in the main forum
  try {
    return await syncExternalThread(interaction, channel);
  } catch (err) {
    logger.error(
      `sync-thread failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    await interaction.editReply(
      `Failed to sync thread: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

async function syncMainForumThread(
  interaction: ChatInputCommandInteraction,
  channel: PublicThreadChannel,
  thread: (typeof store.threads)[number],
) {
  await interaction.editReply("Fetching messages...");
  const allMessages = await fetchAllMessages((opts) =>
    channel.messages.fetch(opts),
  );
  const userMessages = allMessages.filter((m) => !m.author.bot);

  if (userMessages.length === 0) {
    await interaction.editReply(
      "No non-bot messages found in this thread to create an issue from.",
    );
    return;
  }

  const firstMessage = userMessages[0];
  await interaction.editReply("Creating GitHub issue...");
  await createIssue(thread, firstMessage);

  if (!thread.number) {
    await interaction.editReply("Failed to create GitHub issue.");
    return;
  }

  await enrichThreadAfterIssueCreation(thread);

  const remainingMessages = userMessages.slice(1);
  if (remainingMessages.length > 0) {
    await interaction.editReply(
      `Replaying ${remainingMessages.length} message(s) as comments...`,
    );

    for (const msg of remainingMessages) {
      await createIssueComment(thread, msg);
      await delay(1000);
    }
  }

  const issueUrl = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPOSITORY}/issues/${thread.number}`;
  await interaction.editReply(
    `Created issue #${thread.number} with ${remainingMessages.length} comment(s): ${issueUrl}`,
  );
}

async function syncExternalThread(
  interaction: ChatInputCommandInteraction,
  sourceChannel: PublicThreadChannel,
) {
  // Fetch all messages from the source thread
  await interaction.editReply("Fetching messages...");
  const allMessages = await fetchAllMessages((opts) =>
    sourceChannel.messages.fetch(opts),
  );
  const userMessages = allMessages.filter((m) => !m.author.bot);

  if (userMessages.length === 0) {
    await interaction.editReply(
      "No non-bot messages found in this thread to create an issue from.",
    );
    return;
  }

  // Create a new thread in the main forum
  await interaction.editReply("Creating Discord thread in main forum...");
  const forum = client.channels.cache.get(
    config.DISCORD_CHANNEL_ID,
  ) as ForumChannel;

  const firstMessage = userMessages[0];
  const authorName =
    firstMessage.author.globalName ||
    firstMessage.author.displayName ||
    firstMessage.author.username;

  // Forums can require at least one tag — fall back to the intake column
  const appliedTags: string[] = [];
  const fallback = fallbackTagId();
  if (fallback) appliedTags.push(fallback);

  const forumThread = await forum.threads.create({
    message: {
      content: `**${authorName}** (synced from <#${sourceChannel.id}>):\n\n${firstMessage.content || "*(no content)*"}`,
    },
    name: sourceChannel.name,
    appliedTags,
  });

  // Register in store
  store.threads.push({
    id: forumThread.id,
    title: sourceChannel.name,
    appliedTags: [...forumThread.appliedTags],
    comments: [],
    archived: false,
    locked: false,
  });

  const thread = store.threads.find((t) => t.id === forumThread.id)!;

  // Create GitHub issue from the first message
  await interaction.editReply("Creating GitHub issue...");
  await createIssue(thread, firstMessage);

  if (!thread.number) {
    await interaction.editReply("Failed to create GitHub issue.");
    return;
  }

  // Cross-link the new main-forum thread
  await enrichThreadAfterIssueCreation(thread);

  // Replay remaining messages as GitHub comments + Discord messages in the new thread
  const remainingMessages = userMessages.slice(1);
  if (remainingMessages.length > 0) {
    await interaction.editReply(
      `Replaying ${remainingMessages.length} message(s)...`,
    );

    for (const msg of remainingMessages) {
      await createIssueComment(thread, msg);

      const name =
        msg.author.globalName || msg.author.displayName || msg.author.username;
      await forumThread.send(`**${name}:**\n${msg.content}`);

      await delay(1000);
    }
  }

  const issueUrl = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPOSITORY}/issues/${thread.number}`;
  await interaction.editReply(
    `Created issue #${thread.number} with ${remainingMessages.length} comment(s): ${issueUrl}\nDiscord thread: <#${forumThread.id}>`,
  );
}
