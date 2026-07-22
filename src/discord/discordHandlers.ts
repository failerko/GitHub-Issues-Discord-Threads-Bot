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
  addLabelsToIssue,
  clearIssueType,
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
  removeLabelFromIssue,
  setIssueType,
  setProjectField,
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
  TYPE_TAG_NAMES,
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


function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, idx) => val === b[idx]);
}

/** Reverse-lookup a tag id to its name in the given map. */
function nameForTag(
  map: Map<string, string>,
  tagId: string,
): string | undefined {
  for (const [name, id] of map.entries()) {
    if (id === tagId) return name;
  }
  return undefined;
}

/**
 * Mirror a Discord tag edit back to GitHub. Which map a tag belongs to decides
 * where it is written: tagMap holds labels and issue types, while the board
 * maps hold Status and Priority, which are single-select fields on the project.
 */
async function pushTagChangesToGithub(
  thread: Thread,
  oldTags: string[],
  currentTags: string[],
) {
  const added = currentTags.filter((t) => !oldTags.includes(t));
  const removed = oldTags.filter((t) => !currentTags.includes(t));

  // --- Board fields: only the added tag matters, since each field is
  // single-select and updateKanbanTag already replaces rather than accumulates.
  for (const [map, fieldId, columns, field] of [
    [store.kanbanTagMap, store.statusFieldId, store.kanbanColumns, "Status"],
    [
      store.priorityTagMap,
      store.priorityFieldId,
      store.priorityColumns,
      "Priority",
    ],
  ] as const) {
    if (!fieldId) continue;
    const addedName = added
      .map((id) => nameForTag(map, id))
      .find((n): n is string => n !== undefined);
    if (!addedName || !thread.node_id) continue;

    const option = columns.find((c) => c.name === addedName);
    if (!option) continue;

    thread.lockBoard = true;
    const ok = await setProjectField(thread.node_id, fieldId, option.id);
    if (ok) {
      logger.info(`${field}: set to "${addedName}" from Discord`);
    } else {
      thread.lockBoard = false;
    }
  }

  // --- Labels and issue types
  const addedNames = added
    .map((id) => nameForTag(store.tagMap, id))
    .filter((n): n is string => n !== undefined);
  const removedNames = removed
    .map((id) => nameForTag(store.tagMap, id))
    .filter((n): n is string => n !== undefined);

  const addedTypes = addedNames.filter((n) => TYPE_TAG_NAMES.has(n));
  const addedLabels = addedNames.filter((n) => !TYPE_TAG_NAMES.has(n));
  const removedTypes = removedNames.filter((n) => TYPE_TAG_NAMES.has(n));
  const removedLabels = removedNames.filter((n) => !TYPE_TAG_NAMES.has(n));

  if (addedLabels.length > 0) {
    thread.lockLabeling = true;
    await addLabelsToIssue(thread, addedLabels);
  }
  if (removedLabels.length > 0) {
    thread.lockLabeling = true;
    for (const label of removedLabels) {
      await removeLabelFromIssue(thread, label);
    }
  }

  for (const typeName of addedTypes) {
    thread.lockLabeling = true;
    await setIssueType(thread, typeName);
  }
  // Switching type means adding the new tag before removing the old, so only
  // clear the GitHub type when no type tag remains on the thread at all.
  if (removedTypes.length > 0 && addedTypes.length === 0) {
    const hasRemainingType = currentTags.some((tagId) => {
      const name = nameForTag(store.tagMap, tagId);
      return name !== undefined && TYPE_TAG_NAMES.has(name);
    });
    if (!hasRemainingType) {
      thread.lockLabeling = true;
      await clearIssueType(thread);
    }
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
  const oldTags = thread.appliedTags;
  const currentTags = [...newThread.appliedTags];

  if (!thread.lockTagging && !arraysEqual(oldTags, currentTags)) {
    thread.appliedTags = currentTags;
    await pushTagChangesToGithub(thread, oldTags, currentTags);
  }

  if (thread.lockTagging) {
    thread.lockTagging = false;
    thread.appliedTags = currentTags;
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
