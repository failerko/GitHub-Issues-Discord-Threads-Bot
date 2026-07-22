import {
  AnyThreadChannel,
  Client,
  DMChannel,
  ForumChannel,
  Interaction,
  Message,
  NonThreadGuildBasedChannel,
  PartialMessage,
  ThreadChannel,
} from "discord.js";
import { config } from "../config";
import {
  closeIssue,
  createIssue,
  createIssueComment,
  deleteComment,
  deleteIssue,
  discoverIssueTypes,
  discoverProject,
  getIssues,
  lockIssue,
  openIssue,
  unlockIssue,
} from "../github/githubActions";
import { logger } from "../logger";
import { store } from "../store";
import { Thread } from "../interfaces";
import {
  syncKanbanTags,
  syncPriorityTags,
  syncLabelTags,
  pruneOrphanTags,
  resetOpinionatedTags,
  enrichThreadAfterIssueCreation,
} from "./discordActions";
import {
  registerCommands,
  handleSyncIssueCommand,
  handleSyncThreadCommand,
} from "./discordCommands";

export async function handleClientReady(client: Client) {
  logger.info(`Logged in as ${client.user?.tag}!`);

  store.threads = await getIssues();

  // Fetch cache for closed threads
  const threadPromises = store.threads.map(async (thread) => {
    const cachedChannel = client.channels.cache.get(thread.id) as
      | ThreadChannel
      | undefined;
    if (cachedChannel) {
      cachedChannel.messages.cache.forEach((message) => message.id);
      return thread; // Returning thread as valid
    } else {
      try {
        const channel = (await client.channels.fetch(
          thread.id,
        )) as ThreadChannel;
        channel.messages.cache.forEach((message) => message.id);
        return thread; // Returning thread as valid
      } catch (error) {
        return; // Marking thread as invalid
      }
    }
  });
  const threadPromisesResults = await Promise.all(threadPromises);
  store.threads = threadPromisesResults.filter(
    (thread) => thread !== undefined,
  ) as Thread[];

  logger.info(`Issues loaded : ${store.threads.length}`);

  const forumChannel = (await client.channels.fetch(
    config.DISCORD_CHANNEL_ID,
  )) as ForumChannel;
  store.availableTags = forumChannel.availableTags;

  // Pruning deletes tags, so it may only run when every source that feeds the
  // tag maps succeeded. One failed step would make its tags look orphaned.
  let allTagSyncsSucceeded = true;

  try {
    await resetOpinionatedTags();
  } catch (err) {
    allTagSyncsSucceeded = false;
    logger.error(
      `Tag reset failed during startup: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  try {
    await syncLabelTags();
  } catch (err) {
    allTagSyncsSucceeded = false;
    logger.error(
      `Label sync failed during startup: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  try {
    await discoverIssueTypes();
  } catch (err) {
    logger.error(
      `Issue type discovery failed during startup: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  try {
    const project = await discoverProject();
    if (project) {
      store.projectId = project.projectId;
      store.statusFieldId = project.statusFieldId;
      store.kanbanColumns = project.columns;
      await syncKanbanTags(project.columns);

      store.priorityFieldId = project.priorityFieldId;
      store.priorityColumns = project.priorityColumns;
      if (project.priorityColumns.length > 0) {
        await syncPriorityTags(project.priorityColumns);
      }
    }
  } catch (err) {
    allTagSyncsSucceeded = false;
    logger.error(
      `Kanban init failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  if (allTagSyncsSucceeded) {
    try {
      await pruneOrphanTags();
    } catch (err) {
      logger.error(
        `Tag prune failed during startup: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
  } else {
    logger.warn(
      "Tag prune: skipped because a tag sync step failed; the forum may hold tags with no GitHub source",
    );
  }

  await registerCommands();
}

export async function handleInteractionCreate(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "sync-issue") {
    await handleSyncIssueCommand(interaction);
  } else if (interaction.commandName === "sync-thread") {
    await handleSyncThreadCommand(interaction);
  }
}

export async function handleThreadCreate(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  // Skip if already tracked (bot just created this thread via createThread)
  if (store.threads.some((t) => t.id === params.id)) return;

  const { id, name, appliedTags } = params;

  store.threads.push({
    id,
    appliedTags,
    title: name,
    archived: false,
    locked: false,
    comments: [],
  });
}

export async function handleChannelUpdate(
  params: DMChannel | NonThreadGuildBasedChannel,
) {
  if (params.id !== config.DISCORD_CHANNEL_ID) return;

  if (params.type === 15) {
    store.availableTags = params.availableTags;
  }
}


export async function handleThreadUpdate(
  oldThread: AnyThreadChannel,
  newThread: AnyThreadChannel,
) {
  if (newThread.parentId !== config.DISCORD_CHANNEL_ID) return;

  const { id, archived, locked } = newThread;
  const thread = store.threads.find((item) => item.id === id);
  if (!thread) return;

  // --- Tag change detection ---
  // Tags mirror GitHub one-way (labels, issue type, Status, Priority), so a tag
  // edited in Discord is recorded locally and deliberately not pushed back.
  // Without this the mirror would fight the user: GitHub re-asserts its own
  // state on the next event and any Discord-side edit is overwritten anyway.
  const currentTags = [...newThread.appliedTags];
  thread.appliedTags = currentTags;

  if (thread.lockTagging) {
    thread.lockTagging = false;
  }

  if (thread.locked !== locked && !thread.lockLocking) {
    if (thread.archived) {
      thread.lockArchiving = true;
    }
    thread.locked = locked;
    locked ? lockIssue(thread) : unlockIssue(thread);
  }
  if (thread.archived !== archived) {
    // Update thread.archived immediately to prevent duplicate events when
    // two rapid ThreadUpdate events arrive before the setTimeout fires.
    thread.archived = archived;
    setTimeout(() => {
      // timeout for fixing discord archived post locking
      if (thread.lockArchiving) {
        if (archived) {
          thread.lockArchiving = false;
        }
        thread.lockLocking = false;
        return;
      }
      archived ? closeIssue(thread) : openIssue(thread);
    }, 500);
  }
}

export async function handleMessageCreate(params: Message) {
  const { channelId, author } = params;

  if (author.bot) return;

  const thread = store.threads.find((thread) => thread.id === channelId);

  if (!thread) return;

  if (!thread.body) {
    await createIssue(thread, params);
    await enrichThreadAfterIssueCreation(thread);
  } else {
    createIssueComment(thread, params);
  }
}

export async function handleMessageDelete(params: Message | PartialMessage) {
  const { channelId, id } = params;
  const thread = store.threads.find((i) => i.id === channelId);
  if (!thread) return;

  const commentIndex = thread.comments.findIndex((i) => i.id === id);
  if (commentIndex === -1) return;

  const comment = thread.comments.splice(commentIndex, 1)[0];
  deleteComment(thread, comment.git_id);
}

export async function handleThreadDelete(params: AnyThreadChannel) {
  if (params.parentId !== config.DISCORD_CHANNEL_ID) return;

  const thread = store.threads.find((item) => item.id === params.id);
  if (!thread) return;

  deleteIssue(thread);
}
