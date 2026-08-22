"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type ToolUIPart } from "ai";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { ImageIcon } from "lucide-react";

import { ChatChart } from "./Charts";
import { MealDraft, type MealDraftSpec } from "./MealDraft";

/**
 * Chat, on the AI SDK's `useChat` with AI Elements components.
 *
 * `useChat` owns transport, streaming and message state; AI Elements supplies
 * the conversation, message and tool-call chrome. What's left here is the
 * part that's specific to this product: opening as a ⌘K slide-over rather
 * than a permanent column (chat is the secondary surface — the proactive
 * layer is the product), and rendering a `render_chart` tool result as an
 * actual chart instead of JSON.
 */

const SUGGESTIONS = [
  "How much did I train this week?",
  "Show my weekly load for the last 3 months",
  "What was my fastest 5k, and when?",
  "I had 3 eggs and toast for breakfast",
];

interface ChartOutput {
  ok: boolean;
  title: string;
  type: "bar" | "line" | "scatter";
  points: { x: string; y: number }[];
}


/**
 * Attachment strip and attach button.
 *
 * Both exist because this build of AI Elements holds attachments in state and
 * renders nothing for them — there is no `PromptInputAttachments` component to
 * import. Picking a photo therefore produced no visible change at all, which
 * is indistinguishable from the feature being broken, and was reported as
 * exactly that. The file was attached the whole time.
 *
 * The attach control is a plain button rather than the dropdown-menu item the
 * library suggests. One less thing between the athlete and the camera roll,
 * and one less component that can fail inside a portalled slide-over.
 *
 * Both must be rendered inside <PromptInput> — the hook reads its context.
 */
function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <button
      className="btn"
      type="button"
      onClick={() => attachments.openFileDialog()}
      title="Attach a photo of a meal"
    >
      <ImageIcon size={13} aria-hidden /> Photo
    </button>
  );
}

function AttachedPhotos() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;

  return (
    <div className="attachments">
      {attachments.files.map((file) => (
        <div className="attachment" key={file.id}>
          {file.mediaType?.startsWith("image/") ? (
            // A background image rather than <img>: the url is a blob: handle
            // that AI Elements converts to a data URL on submit, and there is
            // nothing for next/image to optimise.
            <span
              className="attachment-thumb"
              role="img"
              aria-label={file.filename ?? "attached photo"}
              style={{ backgroundImage: `url(${file.url})` }}
            />
          ) : (
            <span className="attachment-thumb" aria-hidden />
          )}
          <span className="attachment-name">{file.filename ?? "photo"}</span>
          <button
            className="attachment-x"
            type="button"
            onClick={() => attachments.remove(file.id)}
            aria-label={`Remove ${file.filename ?? "photo"}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const busy = status === "submitted" || status === "streaming";

  // "Has this hydrated?" — the portal needs `document`, and rendering it during
  // SSR (or on the hydration pass, when the server produced nothing) is a
  // mismatch. useSyncExternalStore answers false on the server and true after,
  // without a setState-in-effect.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    // A chart click opens the panel with a question about that chart already
    // typed — the moment chat stops being a search box you must remember.
    const onSeed = (e: Event) => {
      setOpen(true);
      setText((e as CustomEvent<string>).detail);
      setTimeout(() => inputRef.current?.focus(), 250);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("runnudge:ask", onSeed);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("runnudge:ask", onSeed);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 250);
  }, [open]);

  const ask = (q: string, files?: FileUIPart[]) => {
    const trimmed = q.trim();
    // A photo on its own is a complete message — "here, log this" — so an
    // empty box with an attachment must still send.
    if ((!trimmed && !files?.length) || busy) return;
    setText("");
    void sendMessage({ text: trimmed, files });
  };

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Ask <kbd>⌘K</kbd>
      </button>

      {mounted &&
        createPortal(
          <>
            <div
              className={`scrim ${open ? "on" : ""}`}
              onClick={() => setOpen(false)}
            />

            <aside
              className={`sheet ${open ? "on" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-label="Ask about your training"
            >
              <div className="sheet-head">
                <span className="lbl" style={{ fontSize: 11 }}>
                  Ask · your data only
                </span>
                <div style={{ flex: 1 }} />
                <button
                  className="btn"
                  style={{ padding: "3px 9px" }}
                  onClick={() => setOpen(false)}
                >
                  Esc
                </button>
              </div>

              <Conversation className="sheet-conversation">
                <ConversationContent
                  className="sheet-messages"
                  scrollClassName="sheet-scroll"
                >
                  {messages.length === 0 && (
                    <ConversationEmptyState
                      className="sheet-empty"
                      title="Ask about your training"
                      description="Answers come from SQL run against your own database — every number is queried, never estimated."
                    >
                      <div className="suggestions">
                        {SUGGESTIONS.map((s) => (
                          <button
                            key={s}
                            className="suggestion"
                            onClick={() => ask(s)}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </ConversationEmptyState>
                  )}

                  {messages.map((message) => (
                    <Message from={message.role} key={message.id}>
                      <MessageContent>
                        {message.parts.map((part, i) => {
                          if (part.type === "text") {
                            return <span key={i}>{part.text}</span>;
                          }

                          // A chart tool result becomes an actual chart. Everything
                          // it plots was fetched by an earlier query_metrics call —
                          // render_chart has no data access of its own.
                          if (part.type === "tool-render_chart") {
                            const p = part as ToolUIPart;
                            const out = p.output as ChartOutput | undefined;
                            if (
                              p.state === "output-available" &&
                              out?.points?.length
                            ) {
                              return <ChatChart key={i} spec={out} />;
                            }
                            return null;
                          }

                          // The meal card is interactive and unsaved: the
                          // model proposed it, the athlete corrects the
                          // portions, and only pressing Save writes anything.
                          if (part.type === "tool-propose_meal") {
                            const p = part as ToolUIPart;
                            const out = p.output as MealDraftSpec | undefined;
                            if (p.state === "output-available" && out?.items?.length) {
                              return <MealDraft key={i} spec={out} />;
                            }
                            return null;
                          }

                          if (part.type === "tool-query_metrics") {
                            const p = part as ToolUIPart;
                            const input = p.input as
                              { query?: string; purpose?: string } | undefined;
                            return (
                              <Tool key={i} defaultOpen={false}>
                                <ToolHeader
                                  type={p.type}
                                  state={p.state}
                                  title={input?.purpose ?? "Querying your data"}
                                />
                                <ToolContent>
                                  {/* Showing the SQL is the point: an answer you
                                cannot check is one you must trust blindly. */}
                                  <ToolInput input={input?.query ?? p.input} />
                                  <ToolOutput
                                    output={p.output}
                                    errorText={p.errorText}
                                  />
                                </ToolContent>
                              </Tool>
                            );
                          }

                          return null;
                        })}
                      </MessageContent>
                    </Message>
                  ))}
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>

              <div className="sheet-foot">
                <PromptInput
                  accept="image/*"
                  multiple
                  maxFiles={4}
                  // Anthropic rejects images past ~5 MB and a modern phone
                  // camera clears that on a good day. Failing here with a
                  // readable message beats a 400 from the API mid-stream.
                  maxFileSize={5 * 1024 * 1024}
                  onError={(err) => setAttachError(err.message)}
                  onSubmit={(msg, e) => {
                    e.preventDefault();
                    setAttachError(null);
                    ask(msg.text ?? "", msg.files);
                  }}
                >
                  <PromptInputBody>
                    <AttachedPhotos />
                    <PromptInputTextarea
                      ref={inputRef}
                      value={text}
                      onChange={(e) => setText(e.currentTarget.value)}
                      placeholder="Ask about your runs, load, or lifts…"
                      disabled={busy}
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools>
                      <AttachButton />
                    </PromptInputTools>
                    <span className={`hint ${attachError ? "hint-err" : ""}`}>
                      {attachError ??
                        "Ask about training, or describe / photograph a meal."}
                    </span>
                    <PromptInputSubmit status={status} disabled={busy} />
                  </PromptInputFooter>
                </PromptInput>
              </div>
            </aside>
          </>,
          document.body,
        )}
    </>
  );
}
