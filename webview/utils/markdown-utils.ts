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
 * Unescape common shell/JSON escape sequences in content.
 * This handles escape characters that may appear in GitHub Actions logs
 * from echo commands or JSON output.
 */
function unescapeContent(text: string): string {
  return (
    text
      // Handle escaped backticks first (common in shell output)
      .replace(/\\`/g, '`')
      // Escaped double quotes
      .replace(/\\"/g, '"')
      // Escaped single quotes
      .replace(/\\'/g, "'")
      // Double backslash → single backslash (must come after other escape sequences)
      .replace(/\\\\/g, '\\')
      // Escaped newlines
      .replace(/\\n/g, '\n')
      // Escaped tabs
      .replace(/\\t/g, '\t')
      // Escaped carriage returns
      .replace(/\\r/g, '\r')
      // Remove any remaining standalone backslashes before printable chars
      // (often artifacts from shell escaping)
      .replace(/\\(?=[^\s\\])/g, '')
  );
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

  // First, unescape any shell/JSON escape sequences from the parsed log content
  let html = unescapeContent(markdown);

  // Store code blocks to preserve their content during processing
  const codeBlocks: string[] = [];
  const inlineCode: string[] = [];

  // Extract fenced code blocks first (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const index = codeBlocks.length;
    const langClass = lang || 'text';
    // Unescape the code content as well (remove shell escape artifacts)
    const cleanCode = unescapeContent(code.trim());
    codeBlocks.push(
      `<pre><code class="language-${langClass}">${escapeHtml(cleanCode)}</code></pre>`
    );
    return `__CODE_BLOCK_${index}__`;
  });

  // Extract inline code (`...`)
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const index = inlineCode.length;
    // Unescape the code content as well (remove shell escape artifacts)
    const cleanCode = unescapeContent(code);
    inlineCode.push(`<code>${escapeHtml(cleanCode)}</code>`);
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
  // Note: Only match underscore-based formatting when surrounded by whitespace or at line boundaries
  // to avoid incorrectly parsing variable names like GITHUB_STEP_SUMMARY
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/(^|\s)___(.+?)___(\s|$)/gm, '$1<strong><em>$2</em></strong>$3');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|\s)__(.+?)__(\s|$)/gm, '$1<strong>$2</strong>$3');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/(^|\s)_([^_]+)_(\s|$)/gm, '$1<em>$2</em>$3');

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
