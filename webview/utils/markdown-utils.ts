/**
 * Simple markdown to HTML converter for rendering GitHub summaries.
 * Handles common markdown patterns without external dependencies.
 */

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Process unordered lists
 */
function processUnorderedLists(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let inList = false;

  for (const line of lines) {
    const match = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (match) {
      if (!inList) {
        result.push('<ul>');
        inList = true;
      }
      result.push(`<li>${match[2]}</li>`);
    } else {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      result.push(line);
    }
  }

  if (inList) {
    result.push('</ul>');
  }

  return result.join('\n');
}

/**
 * Process ordered lists
 */
function processOrderedLists(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let inList = false;

  for (const line of lines) {
    const match = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (match) {
      if (!inList) {
        result.push('<ol>');
        inList = true;
      }
      result.push(`<li>${match[2]}</li>`);
    } else {
      if (inList) {
        result.push('</ol>');
        inList = false;
      }
      result.push(line);
    }
  }

  if (inList) {
    result.push('</ol>');
  }

  return result.join('\n');
}

/**
 * Convert table rows to HTML table
 */
function convertTableToHtml(rows: string[]): string {
  if (rows.length < 2) return rows.join('\n');

  const parseRow = (row: string): string[] =>
    row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

  const headerCells = parseRow(rows[0]);
  const isSeparator = /^[\s|:-]+$/.test(rows[1]);
  const dataStartIndex = isSeparator ? 2 : 1;

  let tableHtml = '<table>\n<thead>\n<tr>';
  for (const cell of headerCells) {
    tableHtml += `<th>${cell}</th>`;
  }
  tableHtml += '</tr>\n</thead>\n<tbody>';

  for (let i = dataStartIndex; i < rows.length; i++) {
    const cells = parseRow(rows[i]);
    tableHtml += '\n<tr>';
    for (const cell of cells) {
      tableHtml += `<td>${cell}</td>`;
    }
    tableHtml += '</tr>';
  }

  tableHtml += '\n</tbody>\n</table>';
  return tableHtml;
}

/**
 * Process markdown tables
 */
function processMarkdownTables(html: string): string {
  const lines = html.split('\n');
  const result: string[] = [];
  let inTable = false;
  let tableRows: string[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('|') && trimmedLine.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      tableRows.push(trimmedLine);
    } else {
      if (inTable && tableRows.length >= 2) {
        result.push(convertTableToHtml(tableRows));
      } else if (inTable) {
        result.push(...tableRows);
      }
      inTable = false;
      tableRows = [];
      result.push(line);
    }
  }

  if (inTable && tableRows.length >= 2) {
    result.push(convertTableToHtml(tableRows));
  } else if (inTable) {
    result.push(...tableRows);
  }

  return result.join('\n');
}

/**
 * Convert markdown to HTML.
 * Supports: headings, bold, italic, code, links, lists, tables, blockquotes, hr
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';

  let html = markdown;

  // Escape HTML first to prevent XSS, but preserve our markdown patterns
  // We'll handle code blocks specially to preserve their content
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // Extract fenced code blocks first (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const index = codeBlocks.length;
    const langClass = lang || 'text';
    codeBlocks.push(
      `<pre><code class="language-${langClass}">${escapeHtml(code.trim())}</code></pre>`
    );
    return `__CODE_BLOCK_${index}__`;
  });

  // Extract inline code (`...`)
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const index = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `__INLINE_CODE_${index}__`;
  });

  // Now escape the rest
  html = escapeHtml(html);

  // Restore code blocks and inline code
  html = html.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => codeBlocks[parseInt(index)]);
  html = html.replace(/__INLINE_CODE_(\d+)__/g, (_, index) => inlineCode[parseInt(index)]);

  // Process headers (must come before other patterns)
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^[-*_]{3,}\s*$/gm, '<hr>');

  // Bold and italic (handle bold first to avoid conflicts)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links [text](url) - store original URL in data attribute to prevent webview URL resolution issues
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="#" data-href="$2" target="_blank" rel="noopener" class="external-link">$1</a>'
  );

  // Images ![alt](src)
  html = html.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img src="$2" alt="$1" style="max-width: 100%;">'
  );

  // Blockquotes (note: > is escaped to &gt;)
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Tables
  html = processMarkdownTables(html);

  // Unordered lists
  html = processUnorderedLists(html);

  // Ordered lists
  html = processOrderedLists(html);

  // Paragraphs - wrap remaining text blocks
  html = html
    .split('\n\n')
    .map((block) => {
      block = block.trim();
      if (!block) return '';
      // Don't wrap if it's already an HTML element
      if (/^<(h[1-6]|ul|ol|li|blockquote|pre|table|hr|p|div)/.test(block)) {
        return block;
      }
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  return html;
}
