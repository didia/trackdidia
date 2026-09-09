export const normalizeMessageId = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed;
  }
  const inner = trimmed.replace(/^<|>$/g, "");
  return `<${inner}>`;
};

export const parseReferencesHeader = (references: string[]): string[] =>
  references
    .flatMap((reference) => reference.split(/\s+/))
    .map((reference) => normalizeMessageId(reference))
    .filter((reference): reference is string => Boolean(reference));

export interface YahooConversationResolver {
  findConversationKeyByMessageId(messageId: string): Promise<string | null>;
  registerAlias(messageIdHeader: string, conversationKey: string): Promise<void>;
}

export class InMemoryYahooConversationResolver implements YahooConversationResolver {
  constructor(private readonly aliasMap: Map<string, string>) {}

  findConversationKeyByMessageId(messageId: string): Promise<string | null> {
    return Promise.resolve(this.aliasMap.get(messageId) ?? null);
  }

  registerAlias(messageIdHeader: string, conversationKey: string): Promise<void> {
    this.aliasMap.set(messageIdHeader, conversationKey);
    return Promise.resolve();
  }
}

const collectLinkedKeys = async (
  messageIds: string[],
  resolver: YahooConversationResolver,
): Promise<string[]> => {
  const keys: string[] = [];
  for (const messageId of messageIds) {
    const key = await resolver.findConversationKeyByMessageId(messageId);
    if (key) {
      keys.push(key);
    }
  }
  return [...new Set(keys)];
};

export const resolveYahooConversationKey = async (
  input: {
    messageIdHeader: string | null;
    references: string[];
    inReplyTo: string | null;
  },
  resolver: YahooConversationResolver,
): Promise<string> => {
  const ownMessageId = normalizeMessageId(input.messageIdHeader);
  const referenceIds = [
    ...parseReferencesHeader(input.references),
    ...(normalizeMessageId(input.inReplyTo) ? [normalizeMessageId(input.inReplyTo)!] : []),
  ];

  if (ownMessageId) {
    const ownAlias = await resolver.findConversationKeyByMessageId(ownMessageId);
    if (ownAlias) {
      return ownAlias;
    }
  }

  const linkedKeys = await collectLinkedKeys(referenceIds, resolver);
  if (linkedKeys.length === 1) {
    if (ownMessageId) {
      await resolver.registerAlias(ownMessageId, linkedKeys[0]!);
    }
    return linkedKeys[0]!;
  }
  if (linkedKeys.length > 1) {
    const conversationKey = ownMessageId ?? `orphan:${referenceIds[0] ?? "unknown"}`;
    if (ownMessageId) {
      await resolver.registerAlias(ownMessageId, conversationKey);
    }
    return conversationKey;
  }

  const conversationKey = ownMessageId ?? `orphan:${Date.now()}`;
  if (ownMessageId) {
    await resolver.registerAlias(ownMessageId, conversationKey);
  }
  return conversationKey;
};

export const resolveYahooConversationKeySync = (
  input: {
    messageIdHeader: string | null;
    references: string[];
    inReplyTo: string | null;
  },
  aliasMap: Map<string, string>,
): string => {
  const ownMessageId = normalizeMessageId(input.messageIdHeader);
  const referenceIds = [
    ...parseReferencesHeader(input.references),
    ...(normalizeMessageId(input.inReplyTo) ? [normalizeMessageId(input.inReplyTo)!] : []),
  ];

  if (ownMessageId && aliasMap.has(ownMessageId)) {
    return aliasMap.get(ownMessageId)!;
  }

  const linkedKeys = [
    ...new Set(
      referenceIds
        .map((messageId) => aliasMap.get(messageId))
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  if (linkedKeys.length === 1) {
    if (ownMessageId) {
      aliasMap.set(ownMessageId, linkedKeys[0]!);
    }
    return linkedKeys[0]!;
  }
  if (linkedKeys.length > 1) {
    const conversationKey = ownMessageId ?? `orphan:${referenceIds[0] ?? "unknown"}`;
    if (ownMessageId) {
      aliasMap.set(ownMessageId, conversationKey);
    }
    return conversationKey;
  }

  const conversationKey = ownMessageId ?? `orphan:${Date.now()}`;
  if (ownMessageId) {
    aliasMap.set(ownMessageId, conversationKey);
  }
  return conversationKey;
};
