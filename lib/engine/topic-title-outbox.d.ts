export interface TopicTitlePending {
    id: string;
    channelId: string;
    chatId: string;
    sessionId: string;
    name: string;
}
/** Durable, bounded latest-intent per route; never evict unconfirmed work. */
export declare class TopicTitleOutbox {
    private readonly file?;
    private entries;
    private readonly loadError?;
    constructor(file?: string | undefined);
    list(): Array<[string, TopicTitlePending]>;
    get(key: string): TopicTitlePending | undefined;
    put(key: string, value: Omit<TopicTitlePending, 'id'>): TopicTitlePending;
    remove(key: string, id: string): boolean;
    private check;
    private commit;
}
//# sourceMappingURL=topic-title-outbox.d.ts.map