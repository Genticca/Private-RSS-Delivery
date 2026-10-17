import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { validateDiscordPayload } from '../../src/server/templates/payload.js';
import { DiscordPayloadValidationError } from '../../src/server/templates/payload.js';

describe('dispatcher Discord payload validation', () => {
  it('accepts a valid embed payload', () => {
    expect(
      validateDiscordPayload({ embeds: [{ title: 'Title', description: 'Description', fields: [{ name: 'Stage', value: 'Resolved' }] }] })
    ).toMatchObject({ embeds: [{ title: 'Title' }] });
  });

  it('rejects Discord embed limit violations', () => {
    expect(() => validateDiscordPayload({ embeds: [{ title: 'x'.repeat(257) }] })).toThrow(DiscordPayloadValidationError);
    expect(() => validateDiscordPayload({ embeds: Array.from({ length: 11 }, () => ({ title: 'x' })) })).toThrow(
      DiscordPayloadValidationError
    );
    expect(() =>
      validateDiscordPayload({ embeds: [{ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }] })
    ).toThrow(DiscordPayloadValidationError);
  });

  it('rejects embed text totals above 6000 characters', () => {
    expect(() =>
      validateDiscordPayload({
        embeds: [
          {
            fields: Array.from({ length: 7 }, (_, index) => ({ name: `field-${index}`, value: 'x'.repeat(900) }))
          }
        ]
      })
    ).toThrow(/embed text total/);
  });
  it('validates first-class webhook delivery fields', () => {
    expect(
      validateDiscordPayload({
        content: 'hello',
        flags: 4096,
        thread_name: 'Updates',
        applied_tags: ['123', '456']
      })
    ).toMatchObject({ flags: 4096, thread_name: 'Updates' });

    expect(() => validateDiscordPayload({ flags: -1 })).toThrow(DiscordPayloadValidationError);
    expect(() => validateDiscordPayload({ thread_name: 'x'.repeat(101) })).toThrow(DiscordPayloadValidationError);
    expect(() => validateDiscordPayload({ applied_tags: ['1', '2', '3', '4', '5', '6'] })).toThrow(DiscordPayloadValidationError);
  });

});
