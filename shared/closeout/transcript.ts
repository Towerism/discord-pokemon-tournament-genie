/**
 * Transcripts (§6.5 step 3, ADR-0007): the JSON is the source of truth; the HTML is a readable view of it. The HTML
 * holds whatever staff typed, so every field is escaped and the page has no links, images or scripts: it is served
 * under a `sandbox` CSP as well (§6.5 "Serving exports safely").
 */

export const TRANSCRIPT_VERSION = 1;

export interface TranscriptEmbed {
  title: string | null;
  description: string | null;
  url: string | null;
  fields: { name: string; value: string }[];
}

export interface TranscriptAttachment {
  id: string;
  filename: string;
  size: number;
  contentType: string | null;
}

export interface TranscriptMessage {
  id: string;
  type: number;
  authorId: string;
  authorName: string;
  authorBot: boolean;
  createdAt: string;
  editedAt: string | null;
  content: string;
  referencedMessageId: string | null;
  embeds: TranscriptEmbed[];
  attachments: TranscriptAttachment[];
}

export interface TranscriptJson {
  version: 1;
  exportedAt: string;
  contentIntent: boolean;
  day: { id: number; date: string; title: string };
  channel: { id: string; name: string; parentChannelId: string | null; thread: { type: 'public' | 'private'; archived: boolean } | null };
  highWaterMessageId: string | null;
  messages: TranscriptMessage[];
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for an element body or a quoted attribute; NUL becomes the replacement character. */
export function escapeHtml(text: string): string {
  return text.replaceAll(String.fromCharCode(0), '�').replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

const STYLE =
  'body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1f2328;background:#fff}header p{color:#59636e}ol{list-style:none;padding:0}' +
  'article{border-top:1px solid #d1d9e0;padding:8px 0}.meta{color:#59636e;font-size:12px}.content{white-space:pre-wrap;overflow-wrap:anywhere}' +
  'blockquote{border-left:3px solid #d1d9e0;margin:6px 0;padding:2px 8px}dl{margin:4px 0}dt{font-weight:600}dd{margin:0 0 4px 12px;white-space:pre-wrap}';

function renderEmbed(e: TranscriptEmbed): string {
  const parts = [
    e.title === null ? '' : `<p>${escapeHtml(e.title)}</p>`,
    e.description === null ? '' : `<div class="content">${escapeHtml(e.description)}</div>`,
    e.url === null ? '' : `<p class="meta">${escapeHtml(e.url)}</p>`,
    e.fields.length ? `<dl>${e.fields.map((f) => `<dt>${escapeHtml(f.name)}</dt><dd>${escapeHtml(f.value)}</dd>`).join('')}</dl>` : '',
  ];
  return `<blockquote>${parts.join('')}</blockquote>`;
}

function renderMessage(m: TranscriptMessage): string {
  const meta = [
    `<span>${escapeHtml(m.authorName)}</span>${m.authorBot ? ' <em>(bot)</em>' : ''}`,
    `<span>${escapeHtml(m.authorId)}</span>`,
    `<time>${escapeHtml(m.createdAt)}</time>`,
    ...(m.editedAt === null ? [] : [`edited <time>${escapeHtml(m.editedAt)}</time>`]),
    ...(m.referencedMessageId === null ? [] : [`reply to ${escapeHtml(m.referencedMessageId)}`]),
  ].join(' · ');
  const content = m.content ? `<div class="content">${escapeHtml(m.content)}</div>` : '';
  const files = m.attachments.length ? `<ul>${m.attachments.map((a) => `<li>${escapeHtml(a.filename)} · ${a.size} bytes</li>`).join('')}</ul>` : '';
  return `<li><article id="m${escapeHtml(m.id)}"><div class="meta">${meta}</div>${content}${m.embeds.map(renderEmbed).join('')}${files}</article></li>`;
}

export function renderTranscriptHtml(t: TranscriptJson): string {
  const name = escapeHtml(t.channel.name);
  const heading = t.channel.thread ? `Thread: ${name}` : `#${name}`;
  const kind = t.channel.thread ? ` · ${t.channel.thread.type} thread${t.channel.thread.archived ? ', archived' : ''}` : '';
  const intent = t.contentIntent ? '' : '<p>Exported without the Message Content intent: message text, embeds and attachments may be missing.</p>';
  const count = `${t.messages.length} message${t.messages.length === 1 ? '' : 's'}`;
  return (
    '<!doctype html>\n' +
    `<html lang="en"><head><title>${heading} · ${escapeHtml(t.day.title)} (${escapeHtml(t.day.date)})</title><style>${STYLE}</style></head>` +
    `<body><header><h1>${heading}</h1><p>${escapeHtml(t.day.title)} · ${escapeHtml(t.day.date)}${kind} · exported ${escapeHtml(t.exportedAt)} · ${count}</p>${intent}</header>` +
    `<main><ol>${t.messages.map(renderMessage).join('')}</ol></main></body></html>`
  );
}
