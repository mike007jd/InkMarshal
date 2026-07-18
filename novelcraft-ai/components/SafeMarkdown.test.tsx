import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SafeMarkdown } from '@/components/SafeMarkdown';
import { assistantMarkdownSecurityComponents } from '@/components/assistant-ui/markdown-text';

describe('SafeMarkdown', () => {
  it('does not render markdown images that would trigger browser network requests', () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown>{'![tracking pixel](https://tracker.example/pixel.png)'}</SafeMarkdown>,
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.example');
    expect(html).toContain('tracking pixel');
  });

  it('keeps link sanitization under the safe component even when callers pass components', () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown
        linkClassName="legal-link"
        components={{
          a: ({ href, children }) => <a href={href}>{children}</a>,
          img: ({ src }) => <span data-unsafe-src={src} />,
        }}
      >
        {'[good](https://example.com) [bad](javascript:alert(1)) ![x](/api/private-export)'}
      </SafeMarkdown>,
    );

    expect(html).toContain('class="legal-link"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/api/private-export');
  });

  it('applies the same image and link safety to assistant chat markdown', () => {
    const html = renderToStaticMarkup(
      <>
        {assistantMarkdownSecurityComponents.a({ href: 'https://example.com', children: 'good' })}
        {assistantMarkdownSecurityComponents.a({ href: 'javascript:alert(1)', children: 'bad' })}
        {assistantMarkdownSecurityComponents.img({ src: 'https://tracker.example/x.png', alt: 'pixel' })}
      </>,
    );

    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.example');
    expect(html).toContain('pixel');
  });
});
