import ReactMarkdown, { type Components } from 'react-markdown';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { sanitizeMarkdownHref } from '@/lib/markdown-url';

type SafeMarkdownProps = {
  children: string;
  components?: Components;
  linkClassName?: string;
};

type SafeAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: ReactNode;
  node?: unknown;
};

export function renderSafeMarkdownLink({ href, children, className, node: _node, ...props }: SafeAnchorProps, linkClassName?: string) {
  const safeHref = sanitizeMarkdownHref(href);
  if (!safeHref) return <span>{children}</span>;

  const isHttpExternal = /^https?:/i.test(safeHref);
  const mergedClassName = [className, linkClassName].filter(Boolean).join(' ') || undefined;

  return (
    <a
      {...props}
      href={safeHref}
      className={mergedClassName}
      rel={isHttpExternal ? 'noreferrer noopener' : props.rel}
      target={isHttpExternal ? '_blank' : props.target}
    >
      {children}
    </a>
  );
}

const blockedMarkdownImage: Components['img'] = ({ alt }) => {
  return alt ? <span>{alt}</span> : null;
};

export function SafeMarkdown({ children, components, linkClassName }: SafeMarkdownProps) {
  return (
    <ReactMarkdown
      components={{
        ...components,
        a: props => renderSafeMarkdownLink(props, linkClassName),
        img: blockedMarkdownImage,
      }}
      urlTransform={url => sanitizeMarkdownHref(url) ?? ''}
    >
      {children}
    </ReactMarkdown>
  );
}
