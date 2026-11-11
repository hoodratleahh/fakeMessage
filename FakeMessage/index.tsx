/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Elioflex
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Switch } from "@components/Switch";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message, RenderModalProps, User } from "@vencord/discord-types";
import { ChannelStore, createRoot, Menu, MessageStore, Modal, moment, openModal, React, SelectedChannelStore, showToast as vcShowToast, TextArea, TextInput, UserStore, UserUtils } from "@webpack/common";

// Newer Vencord builds take a ToastData object instead of a plain string.
const showToast = (text: string) => vcShowToast({ text });

/**
 * A fake message is just like a real Discord message, except:
 *  - it is stored locally (plugin settings) instead of on Discord's servers
 *  - it carries a `_isFake` marker so we can offer to remove it
 * Everything else (author, avatar, username, role colors, timestamp, markdown,
 * hover actions, message grouping) is rendered by Discord itself, because the
 * message is injected into the real MessageStore.
 */
interface StoredFakeMessage {
    /** A real Discord-style snowflake (numeric string) encoding `timestamp`. */
    id: string;
    channelId: string;
    authorId: string;
    /** Snapshot of the author's user object, used if the user is not cached after a restart */
    author?: Record<string, any>;
    content: string;
    timestamp: number;
    /** When present, this fake renders as a call log entry (system message) instead of a text message */
    call?: { durationSeconds: number; missed?: boolean };
    /** True for messages added by importing a chat (used to replace them on re-import). */
    imported?: boolean;
}

const MAX_FAKES_PER_CHANNEL = 50;

// Fake messages must use a real snowflake id, not a "fakemessage-…" string:
// Discord does snowflake math (BigInt(id)) on message ids when ordering/grouping
// them, which throws on a non-numeric id — and "Copy Message ID" should give a
// normal numeric id. The id encodes the message's own timestamp so it also sorts
// correctly. A random, per-session starting increment keeps ids unique across
// restarts and imports.
const DISCORD_EPOCH = 1420070400000;
let snowflakeSeq = Math.floor(Math.random() * 0x3fffff);

function makeMessageId(ms: number): string {
    const safeMs = Number.isFinite(ms) ? Math.floor(ms) : Date.now();
    const since = BigInt(Math.max(safeMs, DISCORD_EPOCH + 1) - DISCORD_EPOCH);
    const inc = BigInt((snowflakeSeq++) & 0x3fffff);
    return String((since << 22n) | inc);
}
/** Imported chats are whole conversations, so they get a far higher ceiling. */
const MAX_IMPORTED_PER_CHANNEL = 500;

let fakes: StoredFakeMessage[] = [];
let originalGetMessages: ((channelId?: string) => any) | null = null;
let originalGetMessage: ((channelId: string, messageId: string) => any) | null = null;

// The merged list is asked for many times per render. It only changes when the
// channel's real messages or the fakes do, so it is rebuilt only then.
let fakesVersion = 0;
const combinedCache = new Map<string, { source: any[]; length: number; version: number; out: any[]; }>();

// getUser is patched so a fake author who isn't in Discord's cache (common for
// imported chats) still resolves to a usable User instead of undefined — an
// undefined author crashes the message renderer. Hydrated users are cached and
// dropped whenever the fakes change.
let originalGetUser: ((id: string) => any) | null = null;
const hydratedUsers = new Map<string, User>();

// Diagnostics: the last page error while the plugin is active is saved into the
// plugin's own settings (readable in settings.json) so a crash can be inspected
// after the fact instead of guessed at. Best-effort — a render error caught by
// Discord's own error boundary may not reach these listeners.
let onPageError: ((e: ErrorEvent) => void) | null = null;
let onPageRejection: ((e: PromiseRejectionEvent) => void) | null = null;
let origConsoleError: ((...args: any[]) => void) | null = null;

function recordCrash(label: string, err: any) {
    try {
        const msg = String(err?.message ?? err ?? "");
        // Benign, extremely common browser warnings — not real crashes.
        if (/ResizeObserver loop|Non-Error promise rejection/i.test(msg)) return;
        const entry = {
            at: new Date().toISOString(),
            label,
            message: String(err?.message ?? err ?? "unknown"),
            stack: String(err?.stack ?? "").slice(0, 3000)
        };
        let list: any[] = [];
        try { const prev = JSON.parse((settings.store as any).lastCrash || "[]"); if (Array.isArray(prev)) list = prev; } catch { /* reset */ }
        list.push(entry);
        // Keep the last few so an unrelated error can't bury the relevant one.
        (settings.store as any).lastCrash = JSON.stringify(list.slice(-6));
    } catch { /* nothing we can do */ }
}

const settings = definePluginSettings({
    persist: {
        type: OptionType.BOOLEAN,
        description: "Keep fake messages after restarting Discord",
        restartNeeded: false,
        default: true
    },
    showChatButton: {
        type: OptionType.BOOLEAN,
        description: "Show the 👻 ghost button in the chat bar",
        restartNeeded: false,
        default: true
    },
    showCallButton: {
        type: OptionType.BOOLEAN,
        description: "Show the 📞 call button in the chat bar",
        restartNeeded: false,
        default: true
    },
    showIncomingButton: {
        type: OptionType.BOOLEAN,
        description: "Show the 📲 incoming-call button in the chat bar",
        restartNeeded: false,
        default: true
    },
    clearAll: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button
                variant="dangerPrimary"
                size="small"
                onClick={() => {
                    fakes = [];
                    saveFakes();
                    refresh();
                    showToast("All fake messages removed");
                }}
            >
                Clear all fake messages
            </Button>
        )
    }
});

// --- persistence ------------------------------------------------------------

function loadFakes() {
    fakes = [];
    fakesVersion++;
    hydratedUsers.clear();
    if (!settings.store.persist) return;
    try {
        const raw = (settings.store as any).fakeMessages;
        if (typeof raw === "string" && raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                // Upgrade messages saved by older versions (which used a
                // "fakemessage-…" id) to a real numeric snowflake, so Discord's
                // snowflake math and "Copy Message ID" work. Done once, then saved.
                let migrated = false;
                fakes = parsed.map((f: any) => {
                    if (!f || typeof f.id !== "string" || /^\d{15,25}$/.test(f.id)) return f;
                    migrated = true;
                    const wasImport = /^fakemessage-\d+-[a-z0-9]+-\d+$/.test(f.id);
                    return { ...f, id: makeMessageId(Number(f.timestamp) || Date.now()), imported: f.imported ?? wasImport };
                });
                if (migrated) saveFakes();
            }
        }
    } catch (e) {
        console.error("[FakeMessage] Failed to load fake messages:", e);
    }
}

function saveFakes() {
    fakesVersion++;
    hydratedUsers.clear();
    try {
        (settings.store as any).fakeMessages = JSON.stringify(settings.store.persist ? fakes : []);
    } catch (e) {
        console.error("[FakeMessage] Failed to save fake messages:", e);
    }
}

// --- store patching ---------------------------------------------------------
// The message list renders whatever `MessageStore.getMessages(channelId)`
// returns. By wrapping that collection in a Proxy we can present the fake
// messages as part of the channel's history without ever mutating Discord's
// internal store, so nothing gets synced to the server.

function getFakesForChannel(channelId?: string): StoredFakeMessage[] {
    if (!channelId) return [];
    return fakes.filter(f => f.channelId === channelId);
}

function wrapMessages(collection: any, channelId?: string): any {
    if (!collection || getFakesForChannel(channelId).length === 0) return collection;

    const real = () => (Array.isArray(collection?._array) ? collection._array : []);
    const getFake = (id: string) => getFakesForChannel(channelId).find(f => f.id === id);
    const makeMessage = (fake: StoredFakeMessage) =>
        buildMessage(fake, real().find((m: any) => m && !m._isFake) ?? null);
    const combined = (): any[] => {
        const source = real();
        const hit = combinedCache.get(channelId!);
        if (hit && hit.source === source && hit.length === source.length && hit.version === fakesVersion) return hit.out;

        const fakeMessages = getFakesForChannel(channelId)
            .map(f => {
                // Guard: a single malformed fake must never throw out of getMessages
                // and take the whole channel's message list down with it.
                try { return makeMessage(f); } catch (e) {
                    console.error("[FakeMessage] skipped a fake that failed to build:", e);
                    return null;
                }
            })
            .filter((m): m is Message => m !== null);
        const out = fakeMessages.length === 0
            ? source
            : [...source, ...fakeMessages].sort((a, b) => +a.timestamp - +b.timestamp);
        combinedCache.set(channelId!, { source, length: source.length, version: fakesVersion, out });
        return out;
    };

    return new Proxy(collection, {
        get(target, prop, receiver) {
            if (typeof prop === "symbol") {
                if (prop === Symbol.iterator) {
                    const arr = combined();
                    return arr[Symbol.iterator].bind(arr);
                }
                return Reflect.get(target, prop, receiver);
            }

            switch (prop) {
                case "_array":
                    return combined();
                case "toArray":
                    // A copy: callers are free to reorder what toArray hands them.
                    return () => [...combined()];
                case "get":
                    return (id: string) => {
                        const fake = getFake(id);
                        if (fake) return makeMessage(fake);
                        return target.get(id);
                    };
                case "has":
                    return (id: string) => Boolean(getFake(id)) || target.has(id);
                case "size":
                case "length":
                    return combined().length;
                case "last":
                    return () => {
                        const arr = combined();
                        return arr[arr.length - 1];
                    };
                case "first":
                    return () => combined()[0];
                case "at":
                    return (index: number) => combined()[index];
                case "forEach":
                case "some":
                case "every":
                case "filter":
                case "map":
                case "find":
                case "findIndex":
                case "reduce":
                case "indexOf":
                case "includes":
                case "keys":
                case "values":
                case "entries":
                    return (...args: any[]) => (combined() as any)[prop](...args);
                default:
                    // Keep every other method (receiveMessage, commit, ...) bound
                    // to the real collection so the underlying store keeps working.
                    return Reflect.get(target, prop, receiver);
            }
        }
    });
}

function patchStore() {
    if (originalGetMessages || !MessageStore) return;
    originalGetMessages = MessageStore.getMessages.bind(MessageStore) as any;
    (MessageStore as any).getMessages = function (this: any, channelId?: string) {
        return wrapMessages(originalGetMessages!(channelId), channelId);
    };
    // Discord's context-menu / message lookups use getMessage(channelId, id),
    // which would miss fakes and silently open no menu on right-click. Route it
    // through the proxied collection so fakes resolve there too.
    originalGetMessage = (MessageStore as any).getMessage.bind(MessageStore);
    (MessageStore as any).getMessage = function (this: any, channelId: string, messageId: string) {
        const coll = (MessageStore as any).getMessages(channelId);
        const found = coll && typeof coll.get === "function" ? coll.get(messageId) : undefined;
        if (found) return found;
        return originalGetMessage!(channelId, messageId);
    };
    // A fake author who isn't in the cache would make getUser return undefined,
    // and the message renderer crashes on an undefined author. Fall back to a
    // hydrated user for known fake authors; real users always take precedence.
    if (UserStore && (UserStore as any).getUser) {
        originalGetUser = (UserStore as any).getUser.bind(UserStore);
        (UserStore as any).getUser = function (this: any, id: string) {
            const real = originalGetUser!(id);
            if (real) return real;
            return fakeAuthorUser(id) ?? real;
        };
    }
}

function unpatchStore() {
    if (originalGetMessages) {
        (MessageStore as any).getMessages = originalGetMessages;
        originalGetMessages = null;
    }
    if (originalGetMessage) {
        (MessageStore as any).getMessage = originalGetMessage;
        originalGetMessage = null;
    }
    if (originalGetUser) {
        (UserStore as any).getUser = originalGetUser;
        originalGetUser = null;
    }
    hydratedUsers.clear();
}

/** Force the chat (and anything else subscribed to MessageStore) to re-render. */
function refresh() {
    try {
        (MessageStore as any).emitChange();
    } catch (e) {
        console.error("[FakeMessage] Failed to refresh message store:", e);
    }
}

// --- fake message construction ----------------------------------------------

const MENTION_RE = /<@!?(\d{15,21})>/g;
const ROLE_MENTION_RE = /<@&(\d{15,21})>/g;
const CHANNEL_MENTION_RE = /<#(\d{15,21})>/g;

function extractIds(re: RegExp, content: string): string[] {
    const ids: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(content))) ids.push(match[1]);
    return ids;
}

/**
 * Build a User for a fake whose author isn't in Discord's cache.
 *
 * It CLONES the logged-in User so the result carries Discord's real User
 * prototype — every method the message renderer calls (isNonUserBot, hasFlag,
 * getAvatarURL, …). The previous hand-built object was missing methods and
 * crashed the renderer, which is what broke chat imports (the imported authors
 * aren't cached, so they always went down this path).
 */
function hydrateUser(json: Record<string, any>): User | null {
    if (!json?.id) return null;

    const base: any = UserStore.getCurrentUser();
    if (base) {
        const u: any = Object.create(Object.getPrototypeOf(base));
        Object.assign(u, base, {
            id: String(json.id),
            username: json.username ?? "Unknown",
            globalName: json.globalName ?? json.global_name ?? null,
            discriminator: json.discriminator ?? "0",
            avatar: typeof json.avatar === "string" ? json.avatar : null,
            avatarDecorationData: json.avatarDecoration ?? json.avatarDecorationData ?? null,
            banner: null,
            accentColor: json.accentColor ?? null,
            bot: Boolean(json.bot),
            system: false,
            publicFlags: json.publicFlags ?? 0
        });
        return u as User;
    }

    // Not logged in (no User to clone) — fall back to a minimal hand-built one.
    const user: any = {
        ...json,
        getAvatarURL: (_guildId?: string, size = 128, _animated = false) => {
            if (json.avatar) {
                const ext = json.avatar.startsWith("a_") ? "gif" : "png";
                return `https://cdn.discordapp.com/avatars/${json.id}/${json.avatar}.${ext}?size=${size}`;
            }
            const index = String((BigInt(json.id) >> 22n) % 6n);
            return `https://cdn.discordapp.com/embed/avatars/${index}.png?size=${size}`;
        },
        getAvatarDecorationURL: () => undefined,
        getBannerURL: () => undefined,
        getAccentColor: () => json.accentColor ?? null,
        isNonUserBot: () => false,
        isSystemUser: () => false,
        isVerifiedBot: () => false,
        isClyde: () => false,
        hasAvatarForGuild: () => false,
        hasFlag: () => false,
        toString: () => json.globalName ?? json.username ?? json.id
    };
    return user as User;
}

/** The hydrated User for a fake author id, if any stored fake uses it (cached). */
function fakeAuthorUser(id: string): User | null {
    const hit = hydratedUsers.get(id);
    if (hit) return hit;
    const fake = fakes.find(f => f.authorId === id && f.author);
    if (!fake?.author) return null;
    const u = hydrateUser(fake.author);
    if (u) hydratedUsers.set(id, u);
    return u;
}

function resolveAuthor(fake: StoredFakeMessage): User | undefined {
    const cached = UserStore.getUser(fake.authorId);
    if (cached) return cached;
    if (fake.author) return fakeAuthorUser(fake.authorId) ?? hydrateUser(fake.author) ?? undefined;
    return undefined;
}

/**
 * Build a fake Message. When a real message from the same channel is
 * available, we clone it (same prototype + all its fields) so the fake is
 * byte-for-byte the shape Discord's renderer expects — including every
 * array field the Message component touches (codedLinks, giftCodes,
 * soundboardSounds, ...). Hand-building all of those would be fragile.
 */
function buildMessage(fake: StoredFakeMessage, base: Message | null): Message | null {
    const author = resolveAuthor(fake);
    if (!author) return null;

    const overrides: Record<string, any> = {
        id: fake.id,
        channel_id: fake.channelId,
        author,
        bot: Boolean(author.bot),
        content: fake.content,
        timestamp: new Date(fake.timestamp),
        editedTimestamp: null,
        nonce: fake.id,
        state: "SENT",
        type: 0, // DEFAULT
        flags: 0,
        pinned: false,
        tts: false,
        mentionEveryone: false,
        mentioned: false,
        mentions: extractIds(MENTION_RE, fake.content),
        mentionRoles: extractIds(ROLE_MENTION_RE, fake.content),
        mentionChannels: extractIds(CHANNEL_MENTION_RE, fake.content),
        blocked: false,
        ignored: false,
        nick: null,
        colorString: null,
        member: undefined,
        referencedMessage: undefined,
        messageReference: undefined,
        webhookId: undefined,
        _isFake: true,
        deleted: undefined
    };

    // Content-derived fields that must not leak over from the base message.
    // attachments stays empty: a fake message is not a real server record, and
    // Discord's media player crashes when mounted on one. Imported media is kept
    // as a link in the text instead (see attachmentLinks).
    const clean: Record<string, any> = {
        attachments: [],
        embeds: [],
        reactions: [],
        components: [],
        stickers: [],
        stickerItems: [],
        soundboardSounds: [],
        codedLinks: [],
        giftCodes: [],
        mentionGames: [],
        messageSnapshots: [],
        poll: null,
        potions: null,
        activity: null,
        interaction: null,
        interactionMetadata: null,
        application: null,
        applicationId: null,
        purchaseNotification: null,
        giftingPrompt: null,
        premiumGroupInviteId: null,
        customRenderedContent: null
    };

    // Call log entries are system messages (type 3): no text content, and a
    // `call` record describing the duration + who was on the call. Discord's
    // renderer turns that into the phone-icon row ("11PM called · 5 minutes")
    // or, when the current user was NOT among the participants, a red missed
    // call. Two details matter for it to render without crashing:
    //  - `duration` must be a moment-duration object — Discord calls
    //    `duration.humanize()` on it to format the length.
    //  - a missed call is detected by the current user's absence from
    //    `participants`, not by the duration.
    const isCall = fake.call !== undefined;
    if (isCall) {
        const seconds = fake.call!.durationSeconds;
        const currentUserId = UserStore.getCurrentUser()?.id;
        const missed = fake.call!.missed === true;
        Object.assign(overrides, {
            type: 3, // CALL
            content: "",
            call: {
                duration: missed ? null : (moment ? moment.duration(seconds, "seconds") : seconds),
                endedTimestamp: new Date(fake.timestamp),
                participants: missed
                    ? [fake.authorId]
                    : [fake.authorId, currentUserId].filter(Boolean)
            }
        });
    } else {
        clean.call = null;
    }

    if (base) {
        const msg: any = Object.create(Object.getPrototypeOf(base));
        Object.assign(msg, base, overrides, clean);
        return msg;
    }

    // No base message (empty channel): build a complete standalone record so
    // the renderer never hits an undefined `.length`.
    const msg: any = {
        activity: null,
        activityInstance: null,
        application: null,
        applicationId: null,
        attachments: [],
        call: null,
        changelogId: null,
        codedLinks: [],
        colorString: null,
        components: [],
        customRenderedContent: null,
        embeds: [],
        giftCodes: [],
        giftInfo: null,
        giftingPrompt: null,
        interaction: null,
        interactionData: null,
        interactionError: null,
        interactionMetadata: null,
        isSearchHit: false,
        isUnsupported: false,
        loggingName: null,
        mentionGames: [],
        messageSnapshots: [],
        poll: null,
        potions: null,
        premiumGroupInviteId: null,
        purchaseNotification: null,
        reactions: [],
        referralTrialOfferId: null,
        roleSubscriptionData: null,
        sharedClientTheme: null,
        soundboardSounds: [],
        stickers: [],
        stickerItems: [],
        webhookId: undefined,

        getChannelId: () => fake.channelId,
        hasFlag: () => false,
        isEdited: () => false,
        isCommandType: () => false,
        getContentMessage: () => msg,
        canDeleteOwnMessage: () => false,
        isSystemDM: () => false,
        isFirstMessageInForumPost: () => false,
        isInteractionPlaceholder: () => false,
        isPoll: () => false,
        hasPotions: () => false,
        userHasReactedWithEmoji: () => false,
        getReaction: () => undefined,
        addReaction: () => msg,
        removeReaction: () => msg,
        removeReactionsForEmoji: () => msg,
        addReactionBatch: () => msg
    };
    Object.assign(msg, overrides);
    return msg;
}

function snapshotUser(user: User): Record<string, any> {
    const u = user as any;
    return {
        id: u.id,
        username: u.username,
        globalName: u.globalName,
        discriminator: u.discriminator,
        avatar: u.avatar,
        avatarDecoration: u.avatarDecoration ?? u.avatarDecorationData,
        banner: u.banner,
        accentColor: u.accentColor,
        bot: u.bot,
        publicFlags: u.publicFlags
    };
}

// --- public API ---------------------------------------------------------------

function injectFakeMessage(channelId: string, author: User, content: string, minutesAgo = 0) {
    const text = (content || "").trim();
    if (!text) {
        showToast("Write some content first");
        return;
    }
    if (!author) {
        showToast("Could not find that user");
        return;
    }

    const channelFakes = getFakesForChannel(channelId);
    if (channelFakes.length >= MAX_FAKES_PER_CHANNEL) {
        showToast(`Too many fake messages in this channel (max ${MAX_FAKES_PER_CHANNEL}). Clear some first.`);
        return;
    }

    const timestamp = Date.now() - Math.max(0, minutesAgo) * 60_000;
    fakes.push({
        id: makeMessageId(timestamp),
        channelId,
        authorId: author.id,
        author: snapshotUser(author),
        content: text,
        timestamp
    });

    saveFakes();
    refresh();
    showToast(`Fake message sent as ${author.username}`);
}

/** Parse "mm:ss" (or plain minutes) into seconds. Used for call durations. */
function parseDuration(input: string): number {
    const t = (input || "").trim() || "0";
    if (t.includes(":")) {
        const [m, s] = t.split(":").map(n => parseInt(n, 10) || 0);
        return Math.min(Math.max(m, 0) * 60 + Math.max(s, 0), 60 * 60); // cap at 1 hour
    }
    const n = parseInt(t, 10) || 0;
    return Math.min(Math.max(n, 0) * 60, 60 * 60); // plain number = minutes
}

/** Add a fake call log entry to a DM: a phone-icon system message, e.g. "11PM called · 5 minutes". */
function injectFakeCall(channelId: string, author: User, durationSeconds: number, minutesAgo = 0, missed = false) {
    if (!author) {
        showToast("Could not find that user");
        return;
    }

    const channelFakes = getFakesForChannel(channelId);
    if (channelFakes.length >= MAX_FAKES_PER_CHANNEL) {
        showToast(`Too many fake messages in this channel (max ${MAX_FAKES_PER_CHANNEL}). Clear some first.`);
        return;
    }

    const timestamp = Date.now() - Math.max(0, minutesAgo) * 60_000;
    fakes.push({
        id: makeMessageId(timestamp),
        channelId,
        authorId: author.id,
        author: snapshotUser(author),
        content: "",
        timestamp,
        call: { durationSeconds, missed }
    });

    saveFakes();
    refresh();
    showToast(missed
        ? `Fake missed call from ${author.username} added`
        : `Fake call from ${author.username} added`);
}

function removeFake(messageId: string) {
    const before = fakes.length;
    fakes = fakes.filter(f => f.id !== messageId);
    if (fakes.length !== before) {
        saveFakes();
        refresh();
    }
}

function removeFakesForChannel(channelId: string) {
    const before = fakes.length;
    fakes = fakes.filter(f => f.channelId !== channelId);
    if (fakes.length !== before) {
        saveFakes();
        refresh();
    }
}

// --- data codes ---------------------------------------------------------------
// A data code is a chat as JSON: { format, version, name, messages }, each
// message in Discord's own API shape (content, timestamp, author, attachments,
// embeds). It is what the LocalMessagePreview plugin for Rain copies, and what
// this plugin copies back, so a chat can be carried between the two.

const DATA_FORMAT = "localmessagepreview";
const USER_ID_RE = /^\d{15,25}$/;

interface ImportedMessage {
    authorId: string;
    author: Record<string, any>;
    content: string;
    timestamp: number;
}

interface ParsedDataCode {
    name: string;
    messages: ImportedMessage[];
    /** Entries that can't be shown here: nothing but an embed or sticker, or malformed */
    skipped: number;
}

// A fake (injected) message isn't a real server record, and Discord's inline
// image/video player crashes the renderer when mounted on one. Discord renders a
// bare link to its OWN CDN (or any direct media-file URL) as that inline player,
// even from plain message text — so such a URL anywhere in a fake message's
// content must be neutralised. Wrapping it in a code span keeps it visible and
// copyable but makes Discord treat it as inert text.
const AUTO_MEDIA_URL = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/\S+|https?:\/\/\S+?\.(?:mp4|mov|webm|mkv|m4v|png|jpe?g|gif|gifv|webp|avif|mp3|ogg|wav|flac|m4a)(?:\?\S*)?/gi;

function neutralizeMedia(text: string): string {
    return text.replace(AUTO_MEDIA_URL, m => "`" + m + "`");
}

// Each attachment becomes a labelled link appended to the message text; the URL
// is neutralised later (see neutralizeMedia) so it never renders as inline media.
function attachmentLinks(raw: any): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(a => a && typeof a.url === "string")
        .map(a => {
            const name = typeof a.filename === "string" && a.filename
                ? a.filename
                : a.url.split("?")[0].split("/").pop() || "attachment";
            return `📎 ${name}\n${a.url}`;
        });
}

/** Accepts a data code, a bare list of messages, or a single message. Throws with a readable reason. */
function parseDataCode(text: string): ParsedDataCode {
    let data: any;
    try {
        data = JSON.parse(text.trim());
    } catch {
        throw new Error("That isn't a data code (not valid JSON).");
    }

    let list: any[];
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data?.messages)) list = data.messages;
    else if (data && typeof data === "object" && data.author) list = [data];
    else throw new Error("No messages found in that data code.");

    const messages: ImportedMessage[] = [];
    let skipped = 0;
    for (const item of list) {
        const a = item?.author;
        const timestamp = typeof item?.timestamp === "number" ? item.timestamp : Date.parse(item?.timestamp);
        if (!a || !USER_ID_RE.test(String(a.id)) || !Number.isFinite(timestamp)) { skipped++; continue; }

        let content = typeof item.content === "string" ? item.content : "";
        const links = attachmentLinks(item.attachments);
        if (!content && links.length === 0) {
            // Embeds aren't rebuilt here; keep a link embed's address so the message is not lost.
            const embed = Array.isArray(item.embeds) ? item.embeds.find((e: any) => e?.url || e?.description) : null;
            content = embed?.url ?? embed?.description ?? "";
        }
        const full = neutralizeMedia([content, ...links].filter(Boolean).join("\n"));
        if (!full) { skipped++; continue; }

        messages.push({
            authorId: String(a.id),
            author: {
                id: String(a.id),
                username: a.username ?? "Unknown",
                globalName: a.global_name ?? a.globalName ?? null,
                discriminator: a.discriminator ?? "0",
                avatar: a.avatar ?? null,
                bot: Boolean(a.bot)
            },
            content: full,
            timestamp
        });
    }

    if (messages.length === 0) throw new Error("No usable messages in that data code.");
    messages.sort((x, y) => x.timestamp - y.timestamp);

    const name = typeof data?.name === "string" && data.name.trim() ? data.name.trim() : "Imported chat";
    return { name, messages, skipped };
}

/** A resolved replacement author, keyed by the original author id it stands in for. */
type AuthorRemap = Record<string, { authorId: string; author: Record<string, any>; }>;

/**
 * Add every message of a data code to a channel as fake messages, keeping their
 * times. `remap` optionally swaps an original author for another user, e.g. to
 * show someone else's imported messages as a user you choose (and, since the
 * replacement is a real resolved user, it also sidesteps uncached-author issues).
 */
function importDataCode(channelId: string, text: string, remap?: AuthorRemap, shiftMs = 0): ParsedDataCode {
    const parsed = parseDataCode(text);
    if (shiftMs) for (const m of parsed.messages) m.timestamp += shiftMs;

    // Re-importing a chat replaces the previous import into this channel instead
    // of stacking a duplicate copy on top of it (messages made by hand are kept).
    fakes = fakes.filter(f => !(f.channelId === channelId && f.imported));

    const room = MAX_IMPORTED_PER_CHANNEL - getFakesForChannel(channelId).length;
    if (parsed.messages.length > room) {
        throw new Error(`That chat has ${parsed.messages.length} messages but this channel only has room for ${Math.max(room, 0)} more fake ones. Clear some first.`);
    }

    parsed.messages.forEach(m => {
        const sub = remap?.[m.authorId];
        fakes.push({
            id: makeMessageId(m.timestamp),
            channelId,
            authorId: sub ? sub.authorId : m.authorId,
            author: sub ? sub.author : m.author,
            content: m.content,
            timestamp: m.timestamp,
            imported: true
        });
    });

    saveFakes();
    refresh();
    return parsed;
}

function embedToRaw(embed: any): Record<string, any> {
    const out: Record<string, any> = { type: embed?.type ?? "rich" };
    const title = embed?.rawTitle ?? embed?.title;
    const description = embed?.rawDescription ?? embed?.description;
    if (typeof title === "string") out.title = title;
    if (typeof description === "string") out.description = description;
    if (typeof embed?.url === "string") out.url = embed.url;
    for (const key of ["image", "thumbnail", "video"]) {
        const media = embed?.[key];
        if (media?.url) out[key] = { url: media.url, proxy_url: media.proxyURL ?? media.proxy_url ?? media.url, width: media.width, height: media.height };
    }
    return out;
}

function chatName(channelId: string): string {
    const channel: any = ChannelStore.getChannel(channelId);
    if (channel?.name) return channel.name;
    const names = (channel?.recipients ?? [])
        .map((id: string) => UserStore.getUser(id))
        .filter(Boolean)
        .map((u: any) => u.globalName ?? u.username);
    return names.join(", ") || "Chat";
}

/** The channel as it is on screen right now (real and fake messages) as a data code. */
function exportDataCode(channelId: string): { code: string; count: number; } {
    const collection: any = MessageStore.getMessages(channelId);
    const list: any[] = collection?._array ?? [];
    const messages = list
        .filter(m => m?.author?.id && (m.type === 0 || m.type === 19))
        .map(m => ({
            content: m.content ?? "",
            timestamp: new Date(+m.timestamp).toISOString(),
            edited_timestamp: m.editedTimestamp ? new Date(+m.editedTimestamp).toISOString() : null,
            author: {
                id: m.author.id,
                username: m.author.username,
                global_name: m.author.globalName ?? null,
                avatar: m.author.avatar ?? null,
                discriminator: m.author.discriminator ?? "0",
                bot: Boolean(m.author.bot)
            },
            attachments: JSON.parse(JSON.stringify(m.attachments ?? [])),
            embeds: (m.embeds ?? []).map(embedToRaw)
        }));

    const code = JSON.stringify({ format: DATA_FORMAT, version: 1, name: chatName(channelId), messages }, null, 2);
    return { code, count: messages.length };
}

/** A millisecond time as a value for an <input type="datetime-local">, in local time. */
function toLocalInput(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function readClipboard(): Promise<string> {
    const native = (window as any).DiscordNative?.clipboard?.read;
    return String((typeof native === "function" ? await native() : await navigator.clipboard.readText()) ?? "");
}

// --- UI ----------------------------------------------------------------------

/** Ghost in a bubble — the graphical "fake message" button. */
const FakeMessageIcon: IconComponent = ({ height = 22, width = 22, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        aria-hidden="true"
    >
        <path d="M12 2.8a7.2 7.2 0 0 0-7.2 7.2v8.35a.85.85 0 0 0 1.45.6L8 17.4l1.75 1.55a.85.85 0 0 0 1.15 0L12.65 17.4l1.75 1.55a.85.85 0 0 0 1.15 0L17.3 17.4l1.75 1.55a.85.85 0 0 0 1.45-.6V10A7.2 7.2 0 0 0 12 2.8Z" />
        <circle cx="9.3" cy="10.2" r="1.45" fill="var(--background-primary)" />
        <circle cx="14.7" cy="10.2" r="1.45" fill="var(--background-primary)" />
        <path d="M8 13.6c.8.9 2.2 1.4 4 1.4s3.2-.5 4-1.4c-.3 1.6-1.8 2.7-4 2.7s-3.7-1.1-4-2.7Z" fill="var(--background-primary)" />
    </svg>
);

/** Phone handset — the "fake call" chat bar button. */
const CallIcon: IconComponent = ({ height = 22, width = 22, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
    >
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
);

/** Ringing phone with an incoming arrow — the "fake incoming call" chat bar button. */
const IncomingCallIcon: IconComponent = ({ height = 22, width = 22, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
    >
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        <path d="M12 2v8m0 0 3-3m-3 3L9 7" />
    </svg>
);

type ModalMode = "message" | "call" | "incoming" | "import";

function openFakeMessageModal(user?: User, channelId?: string, mode: ModalMode = "message") {
    const targetChannel = channelId ?? SelectedChannelStore.getChannelId();
    openModal(modalProps => (
        <FakeMessageModal initialUser={user} channelId={targetChannel} modalProps={modalProps} initialMode={mode} />
    ));
}

function FakeMessageModal({ initialUser, channelId, modalProps, initialMode = "message" }: { initialUser?: User; channelId: string; modalProps: RenderModalProps; initialMode?: ModalMode; }) {
    const [mode, setMode] = React.useState<ModalMode>(initialMode);
    const [user, setUser] = React.useState<User | null>(initialUser ?? null);
    const [query, setQuery] = React.useState("");
    const [content, setContent] = React.useState("");
    const [duration, setDuration] = React.useState("5:00");
    const [missed, setMissed] = React.useState(false);
    const [minutesAgo, setMinutesAgo] = React.useState("0");
    const [fetching, setFetching] = React.useState(false);
    const [fetchError, setFetchError] = React.useState<string | null>(null);
    const [code, setCode] = React.useState("");
    const [remap, setRemap] = React.useState<Record<string, string>>({});
    const [importing, setImporting] = React.useState(false);
    const [startAt, setStartAt] = React.useState("");

    // What the pasted data code holds, or why it can't be used.
    const parsed = React.useMemo(() => {
        if (!code.trim()) return null;
        try {
            return { ok: true as const, ...parseDataCode(code) };
        } catch (e) {
            return { ok: false as const, error: (e as Error).message };
        }
    }, [code]);

    // Pre-fill the start-time field with the pasted chat's own first time.
    const originalStart = parsed?.ok ? parsed.messages[0].timestamp : null;
    React.useEffect(() => {
        setStartAt(originalStart == null ? "" : toLocalInput(originalStart));
    }, [originalStart]);

    // The distinct authors in the pasted code, each of which can be replaced.
    const importAuthors = React.useMemo(() => {
        if (!parsed?.ok) return [] as { id: string; label: string; }[];
        const seen = new Map<string, string>();
        for (const m of parsed.messages) {
            if (!seen.has(m.authorId)) seen.set(m.authorId, m.author.globalName || m.author.username || m.authorId);
        }
        return [...seen].map(([id, label]) => ({ id, label }));
    }, [parsed]);

    const results = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [] as User[];
        const all: any = UserStore.getUsers();
        const list: User[] = all && typeof all.values === "function"
            ? Array.from(all.values())
            : Object.values(all ?? {});
        return list
            .filter(u => u && (u.username?.toLowerCase().includes(q) || u.globalName?.toLowerCase().includes(q) || u.id.includes(q)))
            .slice(0, 8);
    }, [query]);

    const fetchById = async () => {
        const id = query.trim();
        if (!id) return;
        setFetching(true);
        setFetchError(null);
        try {
            const u = UserStore.getUser(id) ?? await UserUtils.getUser(id);
            if (u) setUser(u);
            else setFetchError("No user found with that ID.");
        } catch {
            setFetchError("Could not fetch that user.");
        } finally {
            setFetching(false);
        }
    };

    const insert = async () => {
        if (mode === "import") {
            if (importing) return;
            setImporting(true);
            try {
                // Shift the whole chat so its first message lands on the chosen time;
                // the gaps between messages stay exactly as they were.
                let shiftMs = 0;
                if (startAt && parsed?.ok) {
                    const want = new Date(startAt).getTime();
                    if (!Number.isFinite(want)) throw new Error("That start time isn't valid.");
                    shiftMs = want - parsed.messages[0].timestamp;
                }
                // Load EVERY author through Discord so each fake message is attributed
                // to a real, cached User — the same kind of object a normal fake message
                // uses. A replacement ID (if typed) is loaded instead of the original.
                // Fabricated/uncached authors are the fragile path, so we avoid them.
                const resolved: AuthorRemap = {};
                let failed = 0;
                for (const a of importAuthors) {
                    const replaceId = (remap[a.id] || "").trim();
                    if (replaceId && !/^\d{15,25}$/.test(replaceId)) throw new Error(`"${replaceId}" isn't a valid user ID.`);
                    const targetId = replaceId || a.id;
                    const u = UserStore.getUser(targetId) ?? await UserUtils.getUser(targetId).catch(() => null);
                    if (u) resolved[a.id] = { authorId: u.id, author: snapshotUser(u) };
                    else failed++; // couldn't load this one; it keeps its saved snapshot
                }
                const replaced = importAuthors.filter(a => (remap[a.id] || "").trim()).length;
                const result = importDataCode(channelId, code, resolved, shiftMs);
                const notes = [
                    shiftMs ? "retimed" : "",
                    replaced ? `${replaced} replaced` : "",
                    failed ? `${failed} user(s) couldn't be loaded` : ""
                ].filter(Boolean).join(" · ");
                showToast(`Imported ${result.messages.length} message(s) from "${result.name}"${notes ? ` · ${notes}` : ""}`);
                modalProps.onClose();
            } catch (e) {
                showToast((e as Error).message);
            } finally {
                setImporting(false);
            }
            return;
        }
        if (!user) return;
        if (mode === "call") {
            injectFakeCall(channelId, user, missed ? 0 : parseDuration(duration), Number(minutesAgo) || 0, missed);
        } else if (mode === "incoming") {
            modalProps.onClose();
            showIncomingCall(user);
            return;
        } else {
            if (!content.trim()) return;
            injectFakeMessage(channelId, user, content, Number(minutesAgo) || 0);
        }
        modalProps.onClose();
    };

    const name = user ? (user.globalName ?? user.username) : null;

    return (
        <Modal
            {...modalProps}
            size="medium"
            title={mode === "call" ? "Fake Call" : mode === "incoming" ? "Incoming Call" : mode === "import" ? "Import Chat" : "Fake Message"}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                {
                    text: mode === "incoming" ? "Call" : mode === "import" ? (importing ? "Importing…" : "Import") : "Insert",
                    variant: "primary",
                    onClick: insert,
                    disabled: mode === "import" ? (!parsed?.ok || importing) : !user || (mode === "message" && !content.trim())
                }
            ]}
        >
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                <Button
                    size="small"
                    variant={mode === "message" ? "primary" : "secondary"}
                    onClick={() => setMode("message")}
                >
                    💬 Message
                </Button>
                <Button
                    size="small"
                    variant={mode === "call" ? "primary" : "secondary"}
                    onClick={() => setMode("call")}
                >
                    📞 Call
                </Button>
                <Button
                    size="small"
                    variant={mode === "incoming" ? "primary" : "secondary"}
                    onClick={() => setMode("incoming")}
                >
                    📲 Incoming
                </Button>
                <Button
                    size="small"
                    variant={mode === "import" ? "primary" : "secondary"}
                    onClick={() => setMode("import")}
                >
                    📥 Import
                </Button>
            </div>
            {mode === "import" ? (
                <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                        Paste a chat's data code. Each person is loaded as a real user and their messages are added here — at their original times, or retimed below. Re-importing replaces the last import.
                    </div>
                    <textarea
                        value={code}
                        onChange={e => setCode(e.currentTarget.value)}
                        placeholder='{ "format": "localmessagepreview", "messages": [ … ] }'
                        rows={8}
                        spellCheck={false}
                        style={{
                            width: "100%", boxSizing: "border-box", resize: "vertical", padding: "10px",
                            borderRadius: "8px", border: "1px solid var(--background-modifier-accent)",
                            background: "var(--input-background, var(--background-secondary))", color: "var(--text-normal)",
                            fontFamily: "var(--font-code)", fontSize: "12px"
                        }}
                    />
                    <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                        <Button
                            size="small"
                            variant="secondary"
                            onClick={async () => {
                                try {
                                    setCode(await readClipboard());
                                } catch {
                                    showToast("Couldn't read the clipboard — paste into the box instead");
                                }
                            }}
                        >
                            Paste from clipboard
                        </Button>
                        <Button
                            size="small"
                            variant="secondary"
                            onClick={async () => {
                                const { code: out, count } = exportDataCode(channelId);
                                if (count === 0) { showToast("No messages in this chat to copy"); return; }
                                await copyToClipboard(out);
                                showToast(`Copied this chat's data code (${count} message(s))`);
                            }}
                        >
                            Copy this chat as data code
                        </Button>
                        <Button
                            size="small"
                            variant="secondary"
                            onClick={() => {
                                const n = getFakesForChannel(channelId).length;
                                if (n === 0) { showToast("No fake messages in this chat"); return; }
                                removeFakesForChannel(channelId);
                                showToast(`Cleared ${n} fake message(s) from this chat`);
                            }}
                        >
                            Clear this chat
                        </Button>
                    </div>
                    {parsed && (
                        <div style={{ fontSize: "12px", marginTop: "10px", color: parsed.ok ? "var(--text-muted)" : "var(--text-danger)" }}>
                            {parsed.ok
                                ? `"${parsed.name}" — ${parsed.messages.length} message(s) from ${new Set(parsed.messages.map(m => m.authorId)).size} user(s), `
                                    + `${new Date(parsed.messages[0].timestamp).toLocaleString()} → ${new Date(parsed.messages[parsed.messages.length - 1].timestamp).toLocaleString()}`
                                    + (parsed.skipped > 0 ? ` · ${parsed.skipped} can't be shown here and will be left out` : "")
                                : parsed.error}
                        </div>
                    )}
                    {parsed?.ok && (
                        <div style={{ marginTop: "12px" }}>
                            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                                When should it start? The whole chat shifts to begin at this time — the gaps between messages stay the same.
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <input
                                    type="datetime-local"
                                    value={startAt}
                                    onChange={e => setStartAt(e.currentTarget.value)}
                                    style={{
                                        padding: "8px 10px", borderRadius: "8px",
                                        border: "1px solid var(--background-modifier-accent)",
                                        background: "var(--input-background, var(--background-secondary))",
                                        color: "var(--text-normal)", colorScheme: "dark", fontSize: "13px"
                                    }}
                                />
                                <Button
                                    size="small"
                                    variant="secondary"
                                    onClick={() => {
                                        const span = parsed.messages[parsed.messages.length - 1].timestamp - parsed.messages[0].timestamp;
                                        setStartAt(toLocalInput(Date.now() - span));
                                    }}
                                >
                                    End just now
                                </Button>
                                <Button size="small" variant="secondary" onClick={() => setStartAt(toLocalInput(parsed.messages[0].timestamp))}>
                                    Original time
                                </Button>
                            </div>
                            {(() => {
                                const want = startAt ? new Date(startAt).getTime() : NaN;
                                const delta = Number.isFinite(want) ? want - parsed.messages[0].timestamp : 0;
                                if (!delta) return null;
                                const last = parsed.messages[parsed.messages.length - 1].timestamp + delta;
                                return (
                                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
                                        Will import as {new Date(want).toLocaleString()} → {new Date(last).toLocaleString()}
                                    </div>
                                );
                            })()}
                        </div>
                    )}
                    {parsed?.ok && importAuthors.length > 0 && (
                        <div style={{ marginTop: "12px" }}>
                            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                                Replace an author (optional) — paste a user ID to show that person's messages as someone else. Blank keeps the original. Tip: replacing with a user you share a server/DM with avoids a missing avatar.
                            </div>
                            {importAuthors.map(a => (
                                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                                    <span
                                        title={a.id}
                                        style={{ fontSize: "12px", color: "var(--header-primary)", minWidth: "110px", maxWidth: "110px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                    >
                                        {a.label}
                                    </span>
                                    <span style={{ color: "var(--text-muted)" }}>→</span>
                                    <div style={{ flex: 1 }}>
                                        <TextInput
                                            value={remap[a.id] ?? ""}
                                            onChange={(v: string) => setRemap(prev => ({ ...prev, [a.id]: v }))}
                                            placeholder="replacement user ID (optional)"
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            ) : user ? (
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
                    <img
                        src={user.getAvatarURL(void 0, 64, true)}
                        alt=""
                        style={{ width: "40px", height: "40px", borderRadius: "50%" }}
                    />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "700", color: "var(--header-primary)" }}>{name}</div>
                        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                            Client-side only — appears in your chat, nobody else sees it.
                        </div>
                    </div>
                    <Button size="small" variant="secondary" onClick={() => setUser(null)}>
                        Change
                    </Button>
                </div>
            ) : (
                <div style={{ marginBottom: "16px" }}>
                    <TextInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search a user by name… or paste a user ID"
                        autoFocus
                    />
                    {fetchError && (
                        <div style={{ fontSize: "12px", color: "var(--text-danger)", marginTop: "6px" }}>{fetchError}</div>
                    )}
                    {results.length > 0 && (
                        <div style={{
                            marginTop: "8px", border: "1px solid var(--background-modifier-accent)",
                            borderRadius: "8px", overflow: "hidden"
                        }}>
                            {results.map(u => (
                                <div
                                    key={u.id}
                                    onClick={() => setUser(u)}
                                    style={{
                                        display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px",
                                        cursor: "pointer", background: "var(--background-secondary)"
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = "var(--background-modifier-hover)"; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = "var(--background-secondary)"; }}
                                >
                                    <img
                                        src={u.getAvatarURL(void 0, 64, true)}
                                        alt=""
                                        style={{ width: "28px", height: "28px", borderRadius: "50%" }}
                                    />
                                    <span style={{ fontWeight: "600", color: "var(--header-primary)" }}>{u.globalName ?? u.username}</span>
                                    <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>{u.username}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {results.length === 0 && query.trim() && (
                        <Button
                            size="small"
                            variant="secondary"
                            onClick={fetchById}
                            disabled={fetching}
                            style={{ marginTop: "8px" }}
                        >
                            {fetching ? "Looking up…" : "Use this user ID"}
                        </Button>
                    )}
                </div>
            )}
            {mode === "import" ? null : mode === "incoming" ? (
                <div style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.5, padding: "8px 0" }}>
                    Shows a full-screen incoming-call screen with <strong>{name ?? "this user"}</strong>'s avatar,
                    a pulsing ring, and accept / decline buttons. Accepting starts a fake call timer.
                    Purely visual — nothing is actually dialed.
                </div>
            ) : mode === "call" ? (
                <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                        Call duration (mm:ss) — <strong>0:00</strong> = missed call
                    </div>
                    <TextInput
                        value={duration}
                        onChange={v => setDuration(v.replace(/[^\d:]/g, "").slice(0, 8))}
                        placeholder="5:00"
                    />
                    <div style={{ marginTop: "12px" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: "12px", cursor: "pointer" }}>
                            <Switch checked={missed} onChange={setMissed} />
                            <div>
                                <div style={{ fontWeight: "600", color: "var(--header-primary)" }}>Missed call</div>
                                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                                    The call was never answered — renders as a red missed-call entry
                                </div>
                            </div>
                        </label>
                    </div>
                </div>
            ) : (
                <TextArea
                    value={content}
                    onChange={setContent}
                    placeholder="Message content… (markdown, mentions and emoji all work)"
                    rows={3}
                    maxLength={2000}
                />
            )}
            {mode !== "incoming" && mode !== "import" && (
                <div style={{ marginTop: "12px" }}>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                        {mode === "call" ? "Call" : "Sent"} <strong>{minutesAgo || "0"}</strong> minute{Number(minutesAgo) === 1 ? "" : "s"} ago (0 = right now)
                    </div>
                    <TextInput
                        value={minutesAgo}
                        onChange={v => setMinutesAgo(v.replace(/\D/g, "").slice(0, 4))}
                        placeholder="Minutes ago"
                    />
                </div>
            )}
        </Modal>
    );
}

const UserContextMenu: NavContextMenuPatchCallback = (children, { user }: { user: User; }) => {
    if (!user) return;
    children.push(
        <Menu.MenuItem
            id="vc-fakemessage"
            label="Fake Message"
            action={() => openFakeMessageModal(user)}
        />
    );
};

const MessageContextMenu: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!(message as any)?._isFake) return;
    children.push(
        <Menu.MenuItem
            id="vc-fakemessage-remove"
            label={(message as any).call ? "Remove Fake Call" : "Remove Fake Message"}
            action={() => removeFake(message.id)}
        />
    );
};

// --- incoming call overlay ---------------------------------------------------
// A full-screen, purely visual incoming-call screen: the caller's avatar with
// an animated pulsing ring, their name, and accept / decline buttons. Accepting
// shows a live fake call timer until you hang up. Nothing is actually dialed.

const INCOMING_CALL_KEYFRAMES = `
    @keyframes vc-fakemessage-ring {
        0% { transform: scale(1); opacity: .65; }
        100% { transform: scale(1.9); opacity: 0; }
    }
    @keyframes vc-fakemessage-ring2 {
        0% { transform: scale(1); opacity: 0; }
        30% { transform: scale(1); opacity: .6; }
        100% { transform: scale(1.9); opacity: 0; }
    }
`;

function IncomingCallOverlay({ user, onClose }: { user: User; onClose: () => void }) {
    const [phase, setPhase] = React.useState<"ringing" | "connected">("ringing");
    const [seconds, setSeconds] = React.useState(0);

    React.useEffect(() => {
        if (phase !== "connected") return;
        const t = setInterval(() => setSeconds(s => s + 1), 1000);
        return () => clearInterval(t);
    }, [phase]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const name = user.globalName ?? user.username;
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");

    return (
        <div style={{
            position: "fixed", inset: 0, zIndex: 9999,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: "20px",
            background: "radial-gradient(circle at 50% 30%, rgba(0,0,0,.72), rgba(0,0,0,.92))",
            backdropFilter: "blur(14px)",
            fontFamily: "var(--font-primary)"
        }}>
            <style>{INCOMING_CALL_KEYFRAMES}</style>

            {/* Pulsing ring around the avatar while ringing */}
            <div style={{ position: "relative", width: "180px", height: "180px" }}>
                {phase === "ringing" && (
                    <>
                        <div style={{
                            position: "absolute", inset: 0, borderRadius: "50%",
                            border: "4px solid var(--green-360)",
                            animation: "vc-fakemessage-ring 1.6s ease-out infinite"
                        }} />
                        <div style={{
                            position: "absolute", inset: 0, borderRadius: "50%",
                            border: "4px solid var(--green-360)",
                            animation: "vc-fakemessage-ring2 1.6s ease-out infinite",
                            animationDelay: ".5s"
                        }} />
                    </>
                )}
                <img
                    src={user.getAvatarURL(void 0, 256, true)}
                    alt=""
                    style={{
                        width: "150px", height: "150px", borderRadius: "50%",
                        display: "block", margin: "15px auto",
                        boxShadow: "0 8px 40px rgba(0,0,0,.6), 0 0 0 5px var(--background-tertiary)"
                    }}
                />
            </div>

            <div style={{ fontSize: "24px", fontWeight: "700", color: "var(--header-primary)", maxWidth: "80%", textAlign: "center" }}>
                {name}
            </div>
            <div style={{ fontSize: "16px", color: "var(--text-muted)", marginTop: "-10px" }}>
                {phase === "ringing" ? "Incoming call…" : `${mm}:${ss}`}
            </div>

            {phase === "ringing" ? (
                <div style={{ display: "flex", gap: "40px", marginTop: "16px" }}>
                    <button
                        aria-label="Accept call"
                        title="Accept"
                        onClick={() => setPhase("connected")}
                        style={{
                            width: "76px", height: "76px", borderRadius: "50%", cursor: "pointer",
                            background: "var(--green-360)", color: "#fff", border: "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            boxShadow: "0 6px 20px rgba(59,165,92,.45)",
                            transition: "transform .12s ease, filter .12s ease"
                        }}
                        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    >
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z" />
                        </svg>
                    </button>
                    <button
                        aria-label="Decline call"
                        title="Decline"
                        onClick={onClose}
                        style={{
                            width: "76px", height: "76px", borderRadius: "50%", cursor: "pointer",
                            background: "var(--red-400)", color: "#fff", border: "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            boxShadow: "0 6px 20px rgba(237,66,69,.45)",
                            transition: "transform .12s ease, filter .12s ease"
                        }}
                        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    >
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ transform: "rotate(135deg)" }}>
                            <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z" />
                        </svg>
                    </button>
                </div>
            ) : (
                <button
                    aria-label="End call"
                    title="Hang up"
                    onClick={onClose}
                    style={{
                        width: "76px", height: "76px", borderRadius: "50%", cursor: "pointer",
                        background: "var(--red-400)", color: "#fff", border: "none",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: "0 6px 20px rgba(237,66,69,.45)", marginTop: "16px",
                        transition: "transform .12s ease"
                    }}
                    onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
                >
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ transform: "rotate(135deg)" }}>
                        <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z" />
                    </svg>
                </button>
            )}

            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px" }}>
                Purely visual — no real call is being made
            </div>
        </div>
    );
}

/** Show the full-screen incoming-call overlay for a given caller. Purely visual. */
function showIncomingCall(user: User) {
    if (!user) {
        showToast("Could not find that user");
        return;
    }
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const root = createRoot(mount);
    const close = () => {
        root.unmount();
        mount.remove();
    };
    root.render(<IncomingCallOverlay user={user} onClose={close} />);
}

// --- plugin ------------------------------------------------------------------

export default definePlugin({
    name: "FakeMessage",
    description: "Creates fake messages from real users that look exactly like the real thing — client-side only, nobody else sees them",
    tags: ["Chat", "Fun"],
    authors: [{ name: "Elioflex", id: 0n }],
    dependencies: ["ChatInputButtonAPI"],
    settings,

    chatBarButton: {
        icon: FakeMessageIcon,
        render: ({ channel }) => {
            const { showChatButton } = settings.use(["showChatButton"]);
            if (!showChatButton) return null;
            return (
                <ChatBarButton tooltip="Fake Message" onClick={() => openFakeMessageModal(void 0, channel.id)}>
                    <FakeMessageIcon />
                </ChatBarButton>
            );
        }
    },

    // The plugin's own chatBarButton slot is taken by the ghost; the 📞 and 📲
    // buttons are registered at runtime in start().


    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fakemessage",
            description: "Send a fake message in the current channel as if another user sent it (client-side only)",
            options: [
                {
                    name: "user",
                    description: "The user who appears to have sent the message",
                    type: ApplicationCommandOptionType.USER,
                    required: true
                },
                {
                    name: "content",
                    description: "The message content",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "minutes-ago",
                    description: "How many minutes ago this message was 'sent' (defaults to 0 = right now)",
                    type: ApplicationCommandOptionType.INTEGER
                }
            ],
            execute: async (opts, ctx) => {
                try {
                    const userId = findOption(opts, "user", "");
                    const content = findOption(opts, "content", "");
                    const minutesAgo = Math.max(0, Number(findOption(opts, "minutes-ago", 0)) || 0);

                    if (!userId) return sendBotMessage(ctx.channel.id, { content: "Pick a user." });
                    if (!content.trim()) return sendBotMessage(ctx.channel.id, { content: "Write some content." });

                    const user = UserStore.getUser(userId) ?? await UserUtils.getUser(userId);
                    if (!user) return sendBotMessage(ctx.channel.id, { content: "Could not find that user." });

                    injectFakeMessage(ctx.channel.id, user, content, minutesAgo);
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Failed to create fake message: ${String(e)}` });
                }
            }
        },
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fakecall",
            description: "Add a fake call log entry in this DM — as if you and another user just talked on the phone (client-side only)",
            options: [
                {
                    name: "user",
                    description: "The other person in the call",
                    type: ApplicationCommandOptionType.USER,
                    required: true
                },
                {
                    name: "duration",
                    description: "Call duration as mm:ss or minutes (default 5:00). 0 or 'missed' = missed call",
                    type: ApplicationCommandOptionType.STRING
                },
                {
                    name: "missed",
                    description: "Mark as a missed call (never answered)",
                    type: ApplicationCommandOptionType.BOOLEAN
                },
                {
                    name: "minutes-ago",
                    description: "How many minutes ago the call happened (defaults to 0 = right now)",
                    type: ApplicationCommandOptionType.INTEGER
                }
            ],
            execute: async (opts, ctx) => {
                try {
                    const userId = findOption(opts, "user", "");
                    if (!userId) return sendBotMessage(ctx.channel.id, { content: "Pick a user." });

                    const user = UserStore.getUser(userId) ?? await UserUtils.getUser(userId);
                    if (!user) return sendBotMessage(ctx.channel.id, { content: "Could not find that user." });

                    const missed = Boolean(findOption(opts, "missed", false));
                    const durationRaw = String(findOption(opts, "duration", "5:00") ?? "5:00");
                    const duration = missed ? 0 : parseDuration(durationRaw);
                    const minutesAgo = Math.max(0, Number(findOption(opts, "minutes-ago", 0)) || 0);

                    injectFakeCall(ctx.channel.id, user, duration, minutesAgo, missed);
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Failed to create fake call: ${String(e)}` });
                }
            }
        },
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fakeimport",
            description: "Import the chat data code on your clipboard into this channel as fake messages (client-side only)",
            execute: async (_opts, ctx) => {
                try {
                    const result = importDataCode(ctx.channel.id, await readClipboard());
                    const left = result.skipped > 0 ? ` (${result.skipped} left out)` : "";
                    showToast(`Imported ${result.messages.length} message(s) from "${result.name}"${left}`);
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Import failed: ${(e as Error)?.message ?? String(e)}` });
                }
            }
        },
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fakeexport",
            description: "Copy this chat (real and fake messages on screen) as a data code",
            execute: async (_opts, ctx) => {
                try {
                    const { code, count } = exportDataCode(ctx.channel.id);
                    if (count === 0) return sendBotMessage(ctx.channel.id, { content: "No messages here to copy." });
                    await copyToClipboard(code);
                    showToast(`Copied this chat's data code (${count} message(s))`);
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Export failed: ${(e as Error)?.message ?? String(e)}` });
                }
            }
        }
    ],

    contextMenus: {
        "user-context": UserContextMenu,
        "message": MessageContextMenu,
        "message-context": MessageContextMenu
    },

    start() {
        onPageError = (e: ErrorEvent) => recordCrash("error", e.error ?? e.message);
        onPageRejection = (e: PromiseRejectionEvent) => recordCrash("unhandledrejection", e.reason);
        window.addEventListener("error", onPageError, true);
        window.addEventListener("unhandledrejection", onPageRejection);
        // React logs render errors (the kind an error boundary catches, which never
        // reach the listeners above) through console.error with the Error object.
        origConsoleError = console.error;
        console.error = function (this: any, ...args: any[]) {
            try {
                const err = args.find(a => a instanceof Error);
                if (err) recordCrash("console.error", err);
            } catch { /* ignore */ }
            return origConsoleError!.apply(this, args);
        };

        loadFakes();
        patchStore();
        // The plugin's own `chatBarButton` slot is the ghost message button;
        // the 📞 and 📲 buttons are added at runtime.
        addChatBarButton("FakeMessageCall", ({ channel }) => {
            const { showCallButton } = settings.use(["showCallButton"]);
            if (!showCallButton) return null;
            return (
                <ChatBarButton tooltip="Fake Call" onClick={() => openFakeMessageModal(void 0, channel.id, "call")}>
                    <CallIcon />
                </ChatBarButton>
            );
        }, CallIcon);
        addChatBarButton("FakeMessageIncoming", ({ channel }) => {
            const { showIncomingButton } = settings.use(["showIncomingButton"]);
            if (!showIncomingButton) return null;
            return (
                <ChatBarButton tooltip="Fake Incoming Call" onClick={() => openFakeMessageModal(void 0, channel.id, "incoming")}>
                    <IncomingCallIcon />
                </ChatBarButton>
            );
        }, IncomingCallIcon);
        console.log("[FakeMessage] Plugin started with", fakes.length, "stored fake message(s)");
    },

    stop() {
        if (onPageError) { window.removeEventListener("error", onPageError, true); onPageError = null; }
        if (onPageRejection) { window.removeEventListener("unhandledrejection", onPageRejection); onPageRejection = null; }
        if (origConsoleError) { console.error = origConsoleError; origConsoleError = null; }
        removeChatBarButton("FakeMessageCall");
        removeChatBarButton("FakeMessageIncoming");
        unpatchStore();
        refresh();
        console.log("[FakeMessage] Plugin stopped");
    },

    // Exposed for programmatic use / testing
    injectFakeMessage,
    injectFakeCall,
    showIncomingCall,
    removeFake,
    removeFakesForChannel,
    importDataCode,
    exportDataCode
});
