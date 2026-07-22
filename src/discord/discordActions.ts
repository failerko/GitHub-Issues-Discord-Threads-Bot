import {
  EmbedBuilder,
  ForumChannel,
  MessagePayload,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import { ProjectColumn, Thread } from "../interfaces";
import { octokit, repoCredentials } from "../github/githubActions";
import {
  ActionValue,
  Actions,
  Triggerer,
  getDiscordUrl,
  logger,
} from "../logger";
import { store } from "../store";
import client from "./discord";

// Discord allows 20 tags per forum and 5 per thread. Every source below
// competes for both, so each gets a hard allocation and overflow is skipped
// with a warning rather than pushing setAvailableTags past the limit and
// failing the entire sync.
const TAG_BUDGET = {
  total: 20, // Discord hard limit per forum
  perThread: 5, // Discord hard limit per thread
  types: 3, // Bug / Feature / Task, from GitHub native issue types
  status: 8, // Project Status column tags
  priority: 4, // Project Priority column tags
  labels: 5, // GitHub repo label tags
};

// Labels matching this are milestone markers (M2, M3, ...). They multiply
// without bound, so they are never mirrored as Discord tags.
const MILESTONE_LABEL_PATTERN = /^M\d+$/;

export function isMilestoneLabel(name: string): boolean {
  return MILESTONE_LABEL_PATTERN.test(name);
}

interface OpinionatedTag {
  name: string;
  moderated?: boolean;
  emoji?: { id: null; name: string };
  color?: string; // 6-char hex for GitHub label, no # prefix
  isType?: boolean; // true = synced via GitHub native issue types, not labels
}

// Only issue-type tags are defined here. Everything else that used to live in
// this list is now mirrored from its source of truth on GitHub: repo labels via
// syncLabelTags, and Status/Priority via the project board. The bot no longer
// creates labels on GitHub, so deleting a label there removes its tag here.
const OPINIONATED_TAGS: OpinionatedTag[] = [
  {
    name: "Bug",
    emoji: { id: null, name: "\u{1F534}" },
    color: "d73a4a",
    isType: true,
  },
  {
    name: "Feature",
    emoji: { id: null, name: "\u{1F7E2}" },
    color: "a2eeef",
    isType: true,
  },
  {
    name: "Task",
    emoji: { id: null, name: "\u{1F535}" },
    color: "0075ca",
    isType: true,
  },
];

/** Set of tag names that map to GitHub native issue types (not labels) */
export const TYPE_TAG_NAMES = new Set(
  OPINIONATED_TAGS.filter((t) => t.isType).map((t) => t.name),
);

const COLUMN_COLOR_TO_EMOJI: Record<string, string> = {
  GRAY: "\u{26AB}", // Black circle (closest to gray)
  RED: "\u{1F534}", // Red circle
  ORANGE: "\u{1F7E0}", // Orange circle
  YELLOW: "\u{1F7E1}", // Yellow circle
  GREEN: "\u{1F7E2}", // Green circle
  BLUE: "\u{1F535}", // Blue circle
  PURPLE: "\u{1F7E3}", // Purple circle
  PINK: "\u{1F534}", // Red circle (no pink circle exists)
};

const info = (action: ActionValue, thread: Thread) =>
  logger.info(`${Triggerer.Github} | ${action} | ${getDiscordUrl(thread)}`);

/**
 * IMG-02: Extract image URLs from GitHub markdown content.
 * Handles both markdown image syntax ![alt](url) and HTML <img src="url"> tags.
 * Returns deduplicated array of image URL strings.
 */
export function extractImageUrls(markdown: string): string[] {
  if (!markdown) return [];

  const urls: string[] = [];

  // Markdown images: ![alt](url) or ![alt](url "title")
  const mdRegex = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = mdRegex.exec(markdown)) !== null) {
    urls.push(match[2]);
  }

  // HTML img tags: <img ... src="url" ...>
  const htmlRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlRegex.exec(markdown)) !== null) {
    urls.push(match[1]);
  }

  // Deduplicate
  return [...new Set(urls)];
}

/**
 * IMG-02: Strip image syntax (markdown and HTML) from text so Discord
 * doesn't show raw tags alongside the embeds.
 */
export function stripImageSyntax(markdown: string): string {
  if (!markdown) return markdown;
  return markdown
    .replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, "")
    .replace(/<img\s[^>]*src=["'][^"']+["'][^>]*\/?>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * IMG-02: Create Discord embed objects for image URLs.
 * Discord supports up to 10 embeds per message; slices to 10 if more.
 */
export function createImageEmbeds(imageUrls: string[]): EmbedBuilder[] {
  return imageUrls.slice(0, 10).map((url) => new EmbedBuilder().setImage(url));
}

export async function createThread({
  body,
  login,
  title,
  appliedTags,
  node_id,
  number,
}: {
  body: string;
  login: string;
  title: string;
  appliedTags: string[];
  node_id: string;
  number: number;
}) {
  try {
    const forum = client.channels.cache.get(
      config.DISCORD_CHANNEL_ID,
    ) as ForumChannel;

    // LINK-02: Append [#N] suffix to thread title
    const suffix = ` [#${number}]`;
    const maxBase = 100 - suffix.length;
    const suffixedTitle =
      title.length + suffix.length > 100
        ? title.slice(0, maxBase) + suffix
        : title + suffix;

    // LINK-01: Include GitHub issue URL in first message
    const issueUrl = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPOSITORY}/issues/${number}`;

    // IMG-02: Extract image URLs from body, create embeds, and strip image tags from text
    const imageUrls = body ? extractImageUrls(body) : [];
    const imageEmbeds = createImageEmbeds(imageUrls);
    const displayBody = imageUrls.length > 0 ? stripImageSyntax(body) : body;

    // Build the message content and truncate to Discord's 2000 char limit
    const DISCORD_MAX_CONTENT = 2000;
    const prefix = `**${login}** opened this issue on GitHub: ${issueUrl}\n\n`;
    const truncationNote = `\n\n... [truncated - see full issue on GitHub](${issueUrl})`;
    const bodyText = displayBody || "*No description provided.*";

    let messageContent: string;
    if ((prefix + bodyText).length > DISCORD_MAX_CONTENT) {
      const maxBodyLength =
        DISCORD_MAX_CONTENT - prefix.length - truncationNote.length;
      messageContent =
        prefix + bodyText.slice(0, maxBodyLength) + truncationNote;
    } else {
      messageContent = prefix + bodyText;
    }

    const forumThread = await forum.threads.create({
      message: {
        content: messageContent,
        ...(imageEmbeds.length > 0 && { embeds: imageEmbeds }),
      },
      name: suffixedTitle,
      appliedTags,
    });

    // Directly register in store -- don't rely on handleThreadCreate
    const existingIndex = store.threads.findIndex(
      (t) => t.id === forumThread.id,
    );
    if (existingIndex !== -1) {
      // handleThreadCreate already added it -- patch it
      store.threads[existingIndex].node_id = node_id;
      store.threads[existingIndex].number = number;
      store.threads[existingIndex].body = body;
      store.threads[existingIndex].title = suffixedTitle;
    } else {
      // handleThreadCreate hasn't fired yet -- add it directly
      store.threads.push({
        id: forumThread.id,
        title: suffixedTitle,
        appliedTags: [...forumThread.appliedTags],
        node_id,
        number,
        body,
        comments: [],
        archived: false,
        locked: false,
      });
    }

    // Write Discord URL back to GitHub issue body for restart recovery
    const discordUrl = `https://discord.com/channels/${forum.guildId}/${forumThread.id}/${forumThread.id}`;
    const updatedBody = `${body || ""}\n\n---\n[View on Discord](${discordUrl})`;
    await octokit.rest.issues.update({
      ...repoCredentials,
      issue_number: number,
      body: updatedBody,
    });

    const thread = store.threads.find((t) => t.id === forumThread.id);
    if (thread) info(Actions.Created, thread);
  } catch (err) {
    logger.error(
      `Failed to create thread: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function createComment({
  git_id,
  body,
  login,
  avatar_url,
  node_id,
}: {
  git_id: number;
  body: string;
  login: string;
  avatar_url: string;
  node_id: string;
}) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  // IMG-02: Extract image URLs from body, create embeds, and strip image tags from text
  const imageUrls = body ? extractImageUrls(body) : [];
  const imageEmbeds = createImageEmbeds(imageUrls);
  let displayBody = imageUrls.length > 0 ? stripImageSyntax(body) : body;

  // Truncate comment body to Discord's 2000 char webhook message limit
  const DISCORD_WEBHOOK_MAX_CONTENT = 2000;
  if (displayBody && displayBody.length > DISCORD_WEBHOOK_MAX_CONTENT) {
    const commentTruncNote = "\n\n... [truncated]";
    displayBody =
      displayBody.slice(
        0,
        DISCORD_WEBHOOK_MAX_CONTENT - commentTruncNote.length,
      ) + commentTruncNote;
  }

  channel.parent
    ?.createWebhook({ name: login, avatar: avatar_url })
    .then((webhook) => {
      const messagePayload = MessagePayload.create(webhook, {
        content: displayBody,
        threadId: thread.id,
        ...(imageEmbeds.length > 0 && { embeds: imageEmbeds }),
      }).resolveBody();
      webhook
        .send(messagePayload)
        .then(({ id }) => {
          thread?.comments.push({ id, git_id });
          webhook.delete("Cleanup");

          info(Actions.Commented, thread);
        })
        .catch(console.error);
    })
    .catch(console.error);
}

export async function sendActivityMessage({
  node_id,
  login,
  avatar_url,
  title,
  description,
  color,
}: {
  node_id: string;
  login: string;
  avatar_url: string;
  title: string;
  description: string;
  color: number;
}) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  try {
    const webhook = await channel.parent?.createWebhook({
      name: login,
      avatar: avatar_url,
    });
    if (!webhook) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(color)
      .setTimestamp();

    const messagePayload = MessagePayload.create(webhook, {
      embeds: [embed],
      threadId: thread.id,
    }).resolveBody();
    await webhook.send(messagePayload);
    await webhook.delete("Cleanup");

    info(Actions.Referenced, thread);
  } catch (err) {
    logger.warn(
      `Failed to send activity message to thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function sendActivityMessageByNumber({
  number,
  login,
  avatar_url,
  title,
  description,
  color,
}: {
  number: number;
  login: string;
  avatar_url: string;
  title: string;
  description: string;
  color: number;
}) {
  const thread = store.threads.find((t) => t.number === number);
  if (!thread?.node_id) {
    logger.warn(`Activity: No thread found for issue #${number}`);
    return;
  }

  await sendActivityMessage({
    node_id: thread.node_id,
    login,
    avatar_url,
    title,
    description,
    color,
  });
}

export async function archiveThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || channel.archived) return;

  try {
    await channel.setArchived(true);
    thread.archived = true;
    info(Actions.Closed, thread);
  } catch (err) {
    logger.warn(
      `Failed to archive thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function unarchiveThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.archived) return;

  try {
    await channel.setArchived(false);
    thread.archived = false;
    info(Actions.Reopened, thread);
  } catch (err) {
    logger.warn(
      `Failed to unarchive thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function lockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || channel.locked) return;

  try {
    thread.locked = true;
    if (channel.archived) {
      thread.lockArchiving = true;
      thread.lockLocking = true;
      await channel.setArchived(false);
      await channel.setLocked(true);
      await channel.setArchived(true);
    } else {
      await channel.setLocked(true);
    }
    info(Actions.Locked, thread);
  } catch (err) {
    thread.locked = false; // Revert on failure
    logger.warn(
      `Failed to lock thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function unlockThread(node_id: string | undefined) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel || !channel.locked) return;

  try {
    thread.locked = false;
    if (channel.archived) {
      thread.lockArchiving = true;
      thread.lockLocking = true;
      await channel.setArchived(false);
      await channel.setLocked(false);
      await channel.setArchived(true);
    } else {
      await channel.setLocked(false);
    }
    info(Actions.Unlocked, thread);
  } catch (err) {
    thread.locked = true; // Revert on failure
    logger.warn(
      `Failed to unlock thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function deleteThread(node_id: string | undefined) {
  const { channel, thread } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  try {
    await channel.delete();
    store.deleteThread(thread?.id);
    info(Actions.Deleted, thread);
  } catch (err) {
    logger.warn(
      `Failed to delete thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function getThreadChannel(node_id: string | undefined): Promise<{
  channel: ThreadChannel<boolean> | undefined;
  thread: Thread | undefined;
}> {
  let channel: ThreadChannel<boolean> | undefined;
  if (!node_id) return { thread: undefined, channel };

  const thread = store.threads.find((thread) => thread.node_id === node_id);
  if (!thread) return { thread, channel };

  channel = <ThreadChannel | undefined>client.channels.cache.get(thread.id);
  if (channel) return { thread, channel };

  try {
    const fetchChanel = await client.channels.fetch(thread.id);
    channel = <ThreadChannel | undefined>fetchChanel;
  } catch (err) {
    /* empty */
  }

  return { thread, channel };
}

export async function addTagToThread(node_id: string, tagId: string) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  // Sync store with actual Discord state to prevent stale overwrites
  thread.appliedTags = [...channel.appliedTags];

  // Check if tag is already applied
  if (thread.appliedTags.includes(tagId)) return;

  // Respect Discord's 5-tag per-thread limit
  if (thread.appliedTags.length >= 5) {
    logger.warn(
      `Thread ${thread.title}: Cannot add tag, already at 5-tag limit`,
    );
    return;
  }

  const newTags = [...thread.appliedTags, tagId].slice(0, 5);

  // Set lock flag before making the change
  thread.lockTagging = true;

  try {
    // Handle archived threads: unarchive, modify, re-archive
    const wasArchived = channel.archived;
    if (wasArchived) {
      thread.lockArchiving = true;
      await channel.setArchived(false);
    }

    await channel.setAppliedTags(newTags);
    thread.appliedTags = newTags;

    if (wasArchived) {
      await channel.setArchived(true);
    }

    info(Actions.Tagged, thread);
  } catch (err) {
    logger.warn(
      `Failed to add tag to thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function removeTagFromThread(node_id: string, tagId: string) {
  const { thread, channel } = await getThreadChannel(node_id);
  if (!thread || !channel) return;

  // Sync store with actual Discord state to prevent stale overwrites
  thread.appliedTags = [...channel.appliedTags];

  // Check if tag is actually applied
  if (!thread.appliedTags.includes(tagId)) return;

  const newTags = thread.appliedTags.filter((t) => t !== tagId);

  // Don't remove the last tag if the forum requires one
  if (newTags.length === 0) {
    logger.warn(
      `Thread ${thread.title}: Cannot remove last tag, forum requires at least one`,
    );
    return;
  }

  // Set lock flag before making the change
  thread.lockTagging = true;

  try {
    // Handle archived threads: unarchive, modify, re-archive
    const wasArchived = channel.archived;
    if (wasArchived) {
      thread.lockArchiving = true;
      await channel.setArchived(false);
    }

    await channel.setAppliedTags(newTags);
    thread.appliedTags = newTags;

    if (wasArchived) {
      await channel.setArchived(true);
    }

    info(Actions.Untagged, thread);
  } catch (err) {
    logger.warn(
      `Failed to remove tag from thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

/**
 * Discord rejects setAvailableTags with "Tag names must be unique" and compares
 * names case-insensitively, while every lookup here matches exactly. A forum tag
 * that differs from a project column only in case ("In Progress" vs
 * "In progress"), or two column names that collide once truncated to Discord's
 * 20-character limit, would otherwise be appended as a duplicate and fail the
 * whole batch. Keeps the first occurrence, which is always the existing tag, so
 * tag IDs and the threads referencing them survive.
 */
function dedupeTagsByName<T extends { name: string }>(tags: T[]): T[] {
  const kept = new Map<string, T>();
  const dropped: string[] = [];

  for (const tag of tags) {
    const key = tag.name.toLowerCase();
    if (kept.has(key)) {
      dropped.push(`"${tag.name}" (collides with "${kept.get(key)!.name}")`);
      continue;
    }
    kept.set(key, tag);
  }

  if (dropped.length > 0) {
    logger.warn(`Tags: Skipped duplicate tag name(s): ${dropped.join(", ")}`);
  }
  return [...kept.values()];
}

/** Case-insensitive tag lookup, matching how Discord enforces name uniqueness. */
function findTagByName<T extends { name: string }>(
  tags: T[],
  name: string,
): T | undefined {
  return tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
}

export async function resetOpinionatedTags() {
  const forum = (await client.channels.fetch(
    config.DISCORD_CHANNEL_ID,
  )) as ForumChannel;

  const existingTags = forum.availableTags;
  const existingByName = new Map(
    existingTags.map((t) => [t.name.toLowerCase(), t]),
  );

  // Keep existing tags that match opinionated names (preserves IDs + thread references),
  // add missing ones, and keep any non-opinionated tags (e.g. kanban columns)
  const opinionatedNames = new Set(
    OPINIONATED_TAGS.map((t) => t.name.toLowerCase()),
  );
  const mergedTags = dedupeTagsByName([
    // Existing tags that match opinionated names (preserve their Discord IDs)
    ...existingTags.filter((t) => opinionatedNames.has(t.name.toLowerCase())),
    // New opinionated tags that don't exist yet
    ...OPINIONATED_TAGS.filter((t) => !existingByName.has(t.name.toLowerCase())),
    // Non-opinionated existing tags (kanban columns, etc.)
    ...existingTags.filter((t) => !opinionatedNames.has(t.name.toLowerCase())),
  ]);

  const added = OPINIONATED_TAGS.filter(
    (t) => !existingByName.has(t.name.toLowerCase()),
  );
  if (added.length > 0) {
    await forum.setAvailableTags(mergedTags);
  }

  const refreshed = await forum.fetch();
  store.availableTags = refreshed.availableTags;

  // Populate tagMap: opinionated tag name -> Discord tag ID
  store.tagMap.clear();
  for (const tag of OPINIONATED_TAGS) {
    const matchingTag = findTagByName(store.availableTags, tag.name);
    if (matchingTag) {
      store.tagMap.set(tag.name, matchingTag.id);
    }
  }

  logger.info(
    `Tag sync: ${added.length} new tags added, ${store.tagMap.size} mapped (${store.availableTags.length}/${TAG_BUDGET.total} slots used)`,
  );
}

/**
 * Mirror GitHub repo labels as Discord forum tags. GitHub is the source of
 * truth: the bot never creates labels there, so a label deleted on GitHub
 * simply stops being mirrored. Milestone labels are excluded because they grow
 * without bound and would exhaust the 20-tag forum budget.
 */
export async function syncLabelTags() {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    ...repoCredentials,
    per_page: 100,
  });

  const eligible = labels
    .filter((l) => !isMilestoneLabel(l.name))
    .filter((l) => !TYPE_TAG_NAMES.has(l.name));

  const skippedMilestones = labels.length - eligible.length;
  const withinBudget = eligible.slice(0, TAG_BUDGET.labels);

  if (eligible.length > TAG_BUDGET.labels) {
    logger.warn(
      `Label sync: ${eligible.length} labels eligible but only ${TAG_BUDGET.labels} tag slots reserved. ` +
        `Not mirrored: ${eligible
          .slice(TAG_BUDGET.labels)
          .map((l) => l.name)
          .join(", ")}`,
    );
  }

  const forum = (await client.channels.fetch(
    config.DISCORD_CHANNEL_ID,
  )) as ForumChannel;

  const existing = forum.availableTags;
  const newTags = withinBudget
    .filter((l) => !findTagByName(existing, l.name.slice(0, 20)))
    .map((l) => ({ name: l.name.slice(0, 20) }));

  if (newTags.length > 0) {
    const allTags = dedupeTagsByName([...existing, ...newTags]);
    if (allTags.length > TAG_BUDGET.total) {
      logger.warn(
        `Label sync: adding ${newTags.length} label tag(s) would exceed the ${TAG_BUDGET.total}-tag limit (${existing.length} used). Skipped.`,
      );
      return;
    }
    await forum.setAvailableTags(allTags);
  }

  const refreshed = await forum.fetch();
  store.availableTags = refreshed.availableTags;

  // Label tags share store.tagMap with the type tags, which is what
  // handleLabeled/handleUnlabeled already look up.
  for (const label of withinBudget) {
    const tag = findTagByName(store.availableTags, label.name.slice(0, 20));
    if (tag) store.tagMap.set(label.name, tag.id);
  }

  logger.info(
    `Label sync: ${withinBudget.length} label tags mapped, ${skippedMilestones} milestone label(s) skipped (${store.availableTags.length}/${TAG_BUDGET.total} slots used)`,
  );
}

/** Mirror a project single-select field's options as forum tags. */
export async function syncColumnTags(
  columns: ProjectColumn[],
  options: { budget: number; targetMap: Map<string, string>; field: string },
) {
  const { budget, targetMap, field } = options;
  const forum = (await client.channels.fetch(
    config.DISCORD_CHANNEL_ID,
  )) as ForumChannel;
  const existingTags = forum.availableTags;

  const existingTagNames = new Set(
    existingTags.map((t) => t.name.toLowerCase()),
  );

  const kanbanSlots = Math.min(columns.length, budget);
  const columnsToSync = columns.slice(0, kanbanSlots);

  if (columns.length > budget) {
    logger.warn(
      `${field}: Project has ${columns.length} options but only ${budget} reserved tag slots. Only syncing first ${budget}.`,
    );
  }

  // Filter columns that don't already exist as tags
  const newColumnTags = columnsToSync
    .filter((col) => !existingTagNames.has(col.name.slice(0, 20).toLowerCase()))
    .map((col) => {
      const truncated = col.name.slice(0, 20);
      if (col.name.length > 20) {
        logger.warn(
          `Kanban: Column name "${col.name}" truncated to "${truncated}" for Discord tag`,
        );
      }
      const emojiName = col.color
        ? COLUMN_COLOR_TO_EMOJI[col.color]
        : undefined;
      return {
        name: truncated,
        ...(emojiName && { emoji: { id: null, name: emojiName } }),
      };
    });

  // Build updated tag list: update existing kanban tags with emoji, add new ones
  const updatedExistingTags = existingTags.map((tag) => {
    const matchingCol = columnsToSync.find(
      (col) =>
        col.name.slice(0, 20).toLowerCase() === tag.name.toLowerCase(),
    );
    if (matchingCol?.color && COLUMN_COLOR_TO_EMOJI[matchingCol.color]) {
      return {
        ...tag,
        emoji: { id: null, name: COLUMN_COLOR_TO_EMOJI[matchingCol.color] },
      };
    }
    return tag;
  });

  const allTags = dedupeTagsByName([
    ...updatedExistingTags,
    ...newColumnTags,
  ]);

  // Check total budget
  if (allTags.length > TAG_BUDGET.total) {
    logger.warn(
      `${field}: Cannot create ${newColumnTags.length} tags -- would exceed ${TAG_BUDGET.total}-tag Discord limit (${existingTags.length} already used)`,
    );
    return;
  }

  // Always call setAvailableTags to ensure emoji is set on all tags
  if (newColumnTags.length > 0 || columnsToSync.some((col) => col.color)) {
    await forum.setAvailableTags(allTags);
  }

  // Refresh the forum and update store
  const refreshed = await forum.fetch();
  store.availableTags = refreshed.availableTags;

  targetMap.clear();
  for (const col of columnsToSync) {
    const truncated = col.name.slice(0, 20);
    const matchingTag = findTagByName(store.availableTags, truncated);
    if (matchingTag) {
      targetMap.set(col.name, matchingTag.id);
    }
  }

  logger.info(
    `${field}: ${targetMap.size} column tags synced (${store.availableTags.length}/${TAG_BUDGET.total} tag slots used)`,
  );
}

export function syncKanbanTags(columns: ProjectColumn[]) {
  return syncColumnTags(columns, {
    budget: TAG_BUDGET.status,
    targetMap: store.kanbanTagMap,
    field: "Status",
  });
}

export function syncPriorityTags(columns: ProjectColumn[]) {
  return syncColumnTags(columns, {
    budget: TAG_BUDGET.priority,
    targetMap: store.priorityTagMap,
    field: "Priority",
  });
}

export async function updateKanbanTag(
  contentNodeId: string,
  oldColumnName: string | undefined,
  newColumnName: string,
  // Defaults to Status so existing callers are unchanged; Priority passes its
  // own map so each field replaces only its own tag.
  tagMap: Map<string, string> = store.kanbanTagMap,
  field = "Kanban",
) {
  const { thread, channel } = await getThreadChannel(contentNodeId);
  if (!thread || !channel) return;

  const oldTagId = oldColumnName ? tagMap.get(oldColumnName) : undefined;
  const newTagId = tagMap.get(newColumnName);

  if (!newTagId) {
    logger.warn(
      `${field}: No Discord tag found for column "${newColumnName}" -- column may not be synced`,
    );
    return;
  }

  // Build new tags: remove this field's old tag, add the new one (never accumulate)
  let newTags = [...thread.appliedTags];
  if (oldTagId) {
    newTags = newTags.filter((t) => t !== oldTagId);
  }

  if (!newTags.includes(newTagId)) {
    if (newTags.length >= TAG_BUDGET.perThread) {
      logger.warn(
        `Thread ${thread.title}: Cannot add ${field} tag, at ${TAG_BUDGET.perThread}-tag limit`,
      );
      return;
    }
    newTags.push(newTagId);
  }

  // Set lock flag before making Discord API calls
  thread.lockTagging = true;

  try {
    // Handle archived threads: unarchive, modify, re-archive
    const wasArchived = channel.archived;
    if (wasArchived) {
      thread.lockArchiving = true;
      await channel.setArchived(false);
    }

    await channel.setAppliedTags(newTags);
    thread.appliedTags = newTags;

    if (wasArchived) {
      await channel.setArchived(true);
    }

    info(Actions.Tagged, thread);
  } catch (err) {
    logger.warn(
      `Failed to update kanban tag for thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function enrichThreadAfterIssueCreation(thread: Thread) {
  if (!thread.number) return;

  try {
    // LINK-02: Rename thread with [#N] suffix
    const channel = (await client.channels.fetch(thread.id)) as ThreadChannel;
    const suffix = ` [#${thread.number}]`;
    const maxBase = 100 - suffix.length;
    const newName = thread.title.slice(0, maxBase) + suffix;
    await channel.setName(newName);
    thread.title = newName;

    // LINK-01: Send bot message with GitHub issue URL
    const issueUrl = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPOSITORY}/issues/${thread.number}`;
    await channel.send(`GitHub issue created: ${issueUrl}`);

    // LINK-03: Append Discord URL to GitHub issue body
    const discordUrl = `https://discord.com/channels/${channel.guildId}/${thread.id}/${thread.id}`;
    const updatedBody = `${thread.body}\n\n---\n[View on Discord](${discordUrl})`;
    await octokit.rest.issues.update({
      ...repoCredentials,
      issue_number: thread.number,
      body: updatedBody,
    });
    thread.body = updatedBody;
  } catch (err) {
    logger.warn(
      `Cross-link enrichment failed for thread ${thread.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}
