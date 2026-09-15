import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { providerErrorContent } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
});
afterEach(() => {
  closeSessionDb();
});
describe('provider error retry metadata', () => {
  it('records the durable attempt of the referenced inbound message', () => {
    getInboundDb()
      .prepare("INSERT INTO messages_in (id, kind, timestamp, content, tries) VALUES ('m1', 'chat', ?, '{}', 2)")
      .run(new Date().toISOString());
    expect(JSON.parse(providerErrorContent('Error: ECONNRESET', 'm1'))).toEqual({
      text: 'Error: ECONNRESET',
      providerError: { source: 'runner', attempt: 2 },
    });
  });
  it('never invents retry metadata for missing or uncorrelated messages', () => {
    for (const id of [null, 'missing']) {
      expect(JSON.parse(providerErrorContent('Error: ECONNRESET', id))).toEqual({ text: 'Error: ECONNRESET' });
    }
  });
});
