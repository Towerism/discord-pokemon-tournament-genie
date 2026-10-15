import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type TranscriptJson, renderTranscriptHtml } from './transcript';

const corpus = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../test/fixtures/closeout/xss-corpus.json'), 'utf8')) as string[];
const ALLOWED_TAGS = new Set(['!doctype', 'html', 'head', 'title', 'style', 'body', 'main', 'header', 'h1', 'p', 'ol', 'li', 'article', 'div', 'span', 'time', 'blockquote', 'dl', 'dt', 'dd', 'ul', 'em']);

const message = (over: Partial<TranscriptJson['messages'][number]> = {}): TranscriptJson['messages'][number] => ({
  id: '900000000000000001',
  type: 0,
  authorId: '100000000000000101',
  authorName: 'Ash',
  authorBot: false,
  createdAt: '2026-10-17T15:00:00.000Z',
  editedAt: null,
  content: 'Round 3 starts now.',
  referencedMessageId: null,
  embeds: [],
  attachments: [],
  ...over,
});

const transcript = (over: Partial<TranscriptJson> = {}): TranscriptJson => ({
  version: 1,
  exportedAt: '2026-10-18T02:00:00.000Z',
  contentIntent: true,
  day: { id: 1, date: '2026-10-17', title: 'Saturday' },
  channel: { id: '500000000000000001', name: 'lc-floor', parentChannelId: null, thread: null },
  highWaterMessageId: '900000000000000001',
  messages: [message()],
  ...over,
});

/** Every tag the output opens or closes, and every attribute inside a tag. */
function markup(html: string) {
  const tags = [...html.matchAll(/<\/?([!a-zA-Z][\w-]*)([^>]*)>/g)].map((m) => ({ name: m[1]!.toLowerCase(), attrs: m[2]! }));
  return { tags, stray: html.replace(/<\/?[!a-zA-Z][\w-]*[^>]*>/g, '').includes('<') };
}

describe('renderTranscriptHtml', () => {
  it('renders a small transcript as expected', () => {
    const html = renderTranscriptHtml(
      transcript({
        messages: [
          message(),
          message({
            id: '900000000000000002',
            authorName: 'Genie',
            authorBot: true,
            editedAt: '2026-10-17T15:05:00.000Z',
            content: 'Penalty recorded.',
            referencedMessageId: '900000000000000001',
            embeds: [{ title: 'Penalty #1', description: null, url: null, fields: [{ name: 'Round', value: '3' }] }],
            attachments: [{ id: '700000000000000001', filename: 'deck.png', size: 2048, contentType: 'image/png' }],
          }),
        ],
      }),
    );
    expect(html).toMatchInlineSnapshot(`
      "<!doctype html>
      <html lang="en"><head><title>#lc-floor · Saturday (2026-10-17)</title><style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1f2328;background:#fff}header p{color:#59636e}ol{list-style:none;padding:0}article{border-top:1px solid #d1d9e0;padding:8px 0}.meta{color:#59636e;font-size:12px}.content{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{border-left:3px solid #d1d9e0;margin:6px 0;padding:2px 8px}dl{margin:4px 0}dt{font-weight:600}dd{margin:0 0 4px 12px;white-space:pre-wrap}</style></head><body><header><h1>#lc-floor</h1><p>Saturday · 2026-10-17 · exported 2026-10-18T02:00:00.000Z · 2 messages</p></header><main><ol><li><article id="m900000000000000001"><div class="meta"><span>Ash</span> · <span>100000000000000101</span> · <time>2026-10-17T15:00:00.000Z</time></div><div class="content">Round 3 starts now.</div></article></li><li><article id="m900000000000000002"><div class="meta"><span>Genie</span> <em>(bot)</em> · <span>100000000000000101</span> · <time>2026-10-17T15:00:00.000Z</time> · edited <time>2026-10-17T15:05:00.000Z</time> · reply to 900000000000000001</div><div class="content">Penalty recorded.</div><blockquote><p>Penalty #1</p><dl><dt>Round</dt><dd>3</dd></dl></blockquote><ul><li>deck.png · 2048 bytes</li></ul></article></li></ol></main></body></html>"
    `);
  });

  it('says so when the transcript was exported without message content', () => {
    expect(renderTranscriptHtml(transcript({ contentIntent: false }))).toContain('Exported without the Message Content intent');
  });

  it('names a thread with its parent', () => {
    const html = renderTranscriptHtml(transcript({ channel: { id: '2', name: 'appeal', parentChannelId: '1', thread: { type: 'private', archived: true } } }));
    expect(html).toContain('<h1>Thread: appeal</h1>');
    expect(html).toContain('private thread, archived');
  });

  it('turns no payload of the XSS corpus into markup, wherever it is placed', () => {
    for (const payload of corpus) {
      const html = renderTranscriptHtml(
        transcript({
          channel: { id: '1', name: payload, parentChannelId: null, thread: null },
          day: { id: 1, date: '2026-10-17', title: payload },
          messages: [
            message({
              authorName: payload,
              content: payload,
              embeds: [{ title: payload, description: payload, url: payload, fields: [{ name: payload, value: payload }] }],
              attachments: [{ id: '7', filename: payload, size: 1, contentType: payload }],
            }),
          ],
        }),
      );
      const { tags, stray } = markup(html);
      expect(stray, payload).toBe(false);
      for (const tag of tags) {
        expect(ALLOWED_TAGS.has(tag.name), `${tag.name} from ${payload}`).toBe(true);
        expect(tag.attrs, payload).not.toMatch(/\bon\w+\s*=|href|src|style=/i);
      }
      const css = html.match(/<style>([^<]*)<\/style>/)![1]!;
      expect(css).not.toContain('url(');
      expect(html.match(/<style>/g)).toHaveLength(1);
      expect(html).not.toContain('\u0000');
    }
  });
});
