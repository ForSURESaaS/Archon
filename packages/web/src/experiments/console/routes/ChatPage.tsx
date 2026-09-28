import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { useParams } from 'react-router';
import { FileOutput, MessageSquarePlus, Rows3 } from 'lucide-react';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer } from '../components/ChatComposer';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { WorkingIndicator } from '../components/WorkingIndicator';
import { WorkflowDock } from '../components/WorkflowDock';
import { EmptyState } from '../components/EmptyState';
import { useBackgroundRefresh } from '../lib/background-refresh';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import type { Message } from '../primitives/message';
import type { ConversationSummary } from '../primitives/conversation';

// While a turn is active, refetch messages on this cadence so streamed replies
// still surface if a per-conversation SSE event is dropped (cross-origin
// EventSource in dev can miss bursts). Mirrors RunDetailPage's safety-net poll.
const ACTIVE_POLL_MS = 3000;
// Consider the turn done once the trailing message is an assistant reply that
// has stayed stable this long. Independent of any SSE lock event.
const SETTLE_MS = 6000;
// Hard cap so a turn that never produces a reply (server error, etc.) can't
// disable the composer forever.
const MAX_WAIT_MS = 300_000;
// Distance from the bottom (px) within which we treat the scroll as "at bottom"
// — drives both auto-scroll stickiness and the jump-to-bottom button's visibility.
const NEAR_BOTTOM_PX = 120;
const COMPACT_MESSAGE_COUNT = 12;

/**
 * Project-scoped agent chat. A tab peer of the runs view under a project.
 *
 * Data flow mirrors RunDetailPage: load messages via useEntity(K.messages),
 * keep live via useConversationSSE (invalidate → refetch), render with the
 * shared MessageItem/ToolCallItem cards inside a StreamContextProvider.
 */
export function ChatPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );

  const { data: conversations, error: conversationsError } = useEntity<ConversationSummary[]>(
    projectId !== undefined ? K.conversations(projectId) : 'noop:no-project-convs',
    () => (projectId !== undefined ? skill.listConversations(projectId) : Promise.resolve([]))
  );

  // Active conversation defaults to the most recent web chat, but remains user-selectable.
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [newChatDraft, setNewChatDraft] = useState(false);
  useEffect(() => {
    if (activeConvId !== null || newChatDraft) return;
    const web = (conversations ?? []).find(c => c.platformType === 'web');
    if (web !== undefined) setActiveConvId(web.id);
  }, [conversations, activeConvId, newChatDraft]);

  const { data: messages, error: messagesError } = useEntity<Message[]>(
    activeConvId !== null ? K.messages(activeConvId) : 'noop:no-conv',
    () => (activeConvId !== null ? skill.listMessages(activeConvId) : Promise.resolve([]))
  );

  // `busy` = a reply is pending → composer disabled + recovery poll active.
  // Driven by message content and the send action, NOT by the SSE lock event,
  // so it stays correct even when the per-conversation SSE drops or never
  // connects (which it can, cross-origin in dev). SSE is a pure accelerator.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-error advisory (distinct channel from `error` so it doesn't read as a
  // send failure) — e.g. files dropped from a first message.
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [compactView, setCompactView] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Turn-completion state. The settle timer (below) is the correctness floor — it
  // works even when SSE is absent. The SSE lock event is a fast-path on top of it.
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleSigRef = useRef('');

  // SSE accelerator: invalidates the message cache on text/tool events, and via
  // onLockChange clears `busy` the instant the server releases the conversation
  // lock (conversation_lock:false) instead of waiting out SETTLE_MS. Must be
  // useCallback-stable — the hook's effect depends on it, so an inline lambda
  // would reconnect the EventSource on every render.
  const onLockChange = useCallback((locked: boolean): void => {
    if (locked) return;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setBusy(false);
  }, []);
  useConversationSSE(activeConvId, onLockChange);

  // Derive turn state from the trailing message: a user message means a reply
  // is pending; once an assistant reply lands and stays stable for SETTLE_MS the
  // turn is done. This also recovers a reload mid-turn (trailing user message).
  useEffect(() => {
    const list = messages ?? [];
    const last = list[list.length - 1];
    if (last === undefined) return;
    if (last.role === 'user') {
      settleSigRef.current = '';
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setBusy(true);
      return;
    }
    // Trailing message is an assistant/system reply. Arm the settle timer once;
    // re-arm only on real content change so identical poll refetches (same sig)
    // don't reset it forever.
    const sig = `${list.length}:${last.id}`;
    if (sig === settleSigRef.current) return;
    settleSigRef.current = sig;
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      setBusy(false);
    }, SETTLE_MS);
  }, [messages]);
  useEffect(
    () => (): void => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    []
  );

  // Recovery poll: while a reply is pending, refetch messages on a cadence so a
  // dropped or absent SSE event can't hide the reply. Hard-caps at MAX_WAIT_MS.
  const busySinceRef = useRef(0);
  useEffect(() => {
    if (!busy) return;
    busySinceRef.current = Date.now();
  }, [busy]);
  useBackgroundRefresh(
    () => {
      if (activeConvId === null) return;
      if (Date.now() - busySinceRef.current > MAX_WAIT_MS) {
        setBusy(false);
        return;
      }
      invalidate(K.messages(activeConvId));
    },
    ACTIVE_POLL_MS,
    busy && activeConvId !== null
  );

  // Reveal the raw tool trace inline (toggled from the working indicator).
  const [showTools, setShowTools] = useState(false);

  const startNewChat = useCallback((): void => {
    setNewChatDraft(true);
    setActiveConvId(null);
    setBusy(false);
    setError(null);
    setNotice('New chat ready. It will be created when you send the first message.');
    lastBottomRef.current = true;
    setAtBottom(true);
  }, []);

  const handoffToNewChat = useCallback((): void => {
    if (projectId === undefined || activeConvId === null || busy || creatingChat) return;
    setCreatingChat(true);
    setError(null);
    setNotice(null);
    void (async (): Promise<void> => {
      try {
        const handoff = await skill.createConversationHandoff(activeConvId);
        const firstMessage = [
          `Continue from the previous chat handoff at ${handoff.path}.`,
          'Read it first, preserve its decisions and unfinished work, then briefly confirm the current objective and next action.',
        ].join(' ');
        const conv = await skill.createConversation(projectId, firstMessage);
        setNewChatDraft(false);
        setActiveConvId(conv.conversationId);
        invalidate(K.conversations(projectId));
        invalidate(K.messages(conv.conversationId));
        setBusy(true);
        setNotice(
          `Saved ${handoff.messageCount.toString()} messages to ${handoff.path} and opened a new chat.`
        );
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to create handoff.');
      } finally {
        setCreatingChat(false);
      }
    })();
  }, [activeConvId, busy, creatingChat, projectId]);

  const onSend = (text: string, files?: File[]): void => {
    if (projectId === undefined) return;
    setError(null);
    setNotice(null);
    setBusy(true); // optimistic: disable the composer immediately
    void (async (): Promise<void> => {
      try {
        if (activeConvId === null) {
          const conv = await skill.createConversation(projectId, text);
          setNewChatDraft(false);
          setActiveConvId(conv.conversationId);
          invalidate(K.conversations(projectId));
          invalidate(K.messages(conv.conversationId));
          // createConversation is JSON-only — files can't ride the first message.
          // Surface it as a non-error notice (not silently dropped); phrased so
          // it's actionable once the agent replies (the composer is locked while
          // `busy`), not "now".
          if (files !== undefined && files.length > 0) {
            setNotice(
              "Files aren't attached to the first message of a new chat — re-attach and send them once the chat has started."
            );
          }
        } else {
          await skill.sendMessage(activeConvId, text, files);
          invalidate(K.messages(activeConvId));
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
        setBusy(false); // unblock so the user can retry
      }
      // On success `busy` stays true until the settle detector sees the reply.
    })();
  };

  // Follow intent belongs to the user. Opening/switching a chat starts pinned;
  // scrolling upward disables follow until the user returns to the bottom.
  useLayoutEffect(() => {
    lastBottomRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [activeConvId, compactView]);

  const contentRef = useCallback((node: HTMLDivElement | null): (() => void) | undefined => {
    if (node === null) return undefined;
    const scrollToTail = (): void => {
      if (!lastBottomRef.current) return;
      const el = scrollRef.current;
      if (el !== null) el.scrollTop = el.scrollHeight;
    };
    scrollToTail();
    const observer = new ResizeObserver(scrollToTail);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    lastBottomRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    lastBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  if (projectId === undefined) {
    return <EmptyState title="No project selected." />;
  }

  const messageList = messages ?? [];
  const hiddenMessageCount = compactView
    ? Math.max(0, messageList.length - COMPACT_MESSAGE_COUNT)
    : 0;
  const displayedMessages =
    hiddenMessageCount > 0 ? messageList.slice(hiddenMessageCount) : messageList;

  // Surface a failed (re)load of the conversation list or message history — a
  // revalidation can fail silently (network blip, server restart) and otherwise
  // leave stale/empty data with no signal. Send errors take precedence.
  const loadError = messagesError ?? conversationsError;

  // Current activity for the working indicator: the latest tool the agent
  // invoked in the in-flight turn (walk back to the last user message).
  const currentActivity = useMemo<string | null>(() => {
    for (let i = messageList.length - 1; i >= 0; i--) {
      const m = messageList[i];
      if (m === undefined) continue;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && m.toolCalls.length > 0) {
        return m.toolCalls[m.toolCalls.length - 1]?.name ?? null;
      }
    }
    return null;
  }, [messageList]);

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {project?.name ?? 'Project'}
            </h1>
            <p className="text-xs text-text-tertiary">{project?.path ?? 'Loading…'}</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="sr-only" htmlFor="conversation-select">
              Conversation
            </label>
            <select
              id="conversation-select"
              value={activeConvId ?? ''}
              onChange={event => {
                setNewChatDraft(event.target.value === '');
                setActiveConvId(event.target.value || null);
                setError(null);
                setNotice(null);
              }}
              disabled={busy || creatingChat}
              className="max-w-[260px] rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-primary disabled:opacity-50"
            >
              {activeConvId === null ? <option value="">New unsaved chat</option> : null}
              {(conversations ?? [])
                .filter(conversation => conversation.platformType === 'web')
                .map(conversation => (
                  <option key={conversation.id} value={conversation.id}>
                    {conversation.title?.trim() || 'Untitled conversation'}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setCompactView(value => !value);
              }}
              aria-pressed={compactView}
              title="Keep the complete thread stored, but show only recent messages"
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                compactView
                  ? 'border-brand-magenta/50 bg-brand-magenta/10 text-text-primary'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              <Rows3 className="h-3.5 w-3.5" />
              Compact
            </button>
            <button
              type="button"
              onClick={handoffToNewChat}
              disabled={activeConvId === null || busy || creatingChat}
              title="Export the complete chat to Markdown and continue in a fresh chat"
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            >
              <FileOutput className="h-3.5 w-3.5" />
              {creatingChat ? 'Creating handoff…' : 'Handoff'}
            </button>
            <button
              type="button"
              onClick={startNewChat}
              disabled={busy || creatingChat}
              className="brand-bar flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              New chat
            </button>
          </div>
        </div>
        <ProjectViewTabs projectId={projectId} active="chat" />
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-[30px] pt-[26px] pb-[18px]"
        >
          {/* Match the composer's centered 940px column (design: .stream-inner) */}
          <div ref={contentRef} className="mx-auto max-w-[940px]">
            {hiddenMessageCount > 0 ? (
              <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs text-text-secondary">
                <span>
                  {hiddenMessageCount.toString()} earlier messages are compacted from this view. The
                  complete thread is still stored.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCompactView(false);
                  }}
                  className="ml-3 shrink-0 text-text-primary underline underline-offset-2"
                >
                  Show all
                </button>
              </div>
            ) : null}
            {messageList.length === 0 && !busy ? (
              <EmptyState
                title="No messages yet."
                hint="Ask the agent about this project, or tell it what to run."
              />
            ) : (
              <StreamContextProvider value={{ runStartedAt: null }}>
                <ChatStream messages={displayedMessages} showTools={showTools} />
                {busy ? (
                  <WorkingIndicator
                    activity={currentActivity}
                    expanded={showTools}
                    onToggle={() => {
                      setShowTools(v => !v);
                    }}
                  />
                ) : null}
              </StreamContextProvider>
            )}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Jump to bottom"
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] text-text-secondary shadow-md transition-colors hover:text-text-primary"
          >
            <span aria-hidden>↓</span>
            Jump to bottom
          </button>
        ) : null}
      </div>

      <WorkflowDock projectId={projectId} />

      {notice !== null ? (
        <div className="shrink-0 border-t border-warning/30 bg-warning/[0.06] px-6 py-2 font-mono text-[11px] text-warning">
          {notice}
        </div>
      ) : null}

      {error !== null || loadError !== undefined ? (
        <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-6 py-2 font-mono text-[11px] text-error">
          {error ?? `Failed to load chat: ${loadError?.message ?? 'unknown error'}`}
        </div>
      ) : null}

      <ChatComposer onSend={onSend} disabled={busy} />
    </section>
  );
}
