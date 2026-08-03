import { action } from "@ember/object";
import { withPluginApi } from "discourse/lib/plugin-api";
import { buildQuote } from "discourse/lib/quote";
import Composer from "discourse/models/composer";

// ── Segment-based quote processing ──────────────────────────────────────────
// Parses HTML content into structured segments so links (text + href) can be
// handled separately from plain text during truncation.

/**
 * @typedef {Object} TextSegment
 * @property {"text"} type
 * @property {string} text
 *
 * @typedef {Object} EmojiSegment
 * @property {"emoji"} type
 * @property {string} text   - raw emoji code from alt attribute (e.g. :wave:)
 *
 * @typedef {Object} LinkSegment
 * @property {"link"} type
 * @property {string} text   - display text
 * @property {string} href   - full URL
 * @property {boolean} isBareLink - text === href
 * @property {boolean} [isImage]  - link wraps a non-emoji <img>
 */

/**
 * Strip HTML tags and normalise whitespace from a raw HTML fragment.
 * Does NOT handle emoji <img> tags — those should be extracted by
 * parseInlineContent before this function is called on the remaining HTML.
 */
function extractTextFromHtml(html) {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/**
 * Parse an inline HTML fragment into structured segments.
 *
 * - Emoji (<img class="...emoji..." alt=":code:">) → EmojiSegment (width = 1).
 * - Other <img> (standalone, not wrapped in <a>) → image segment when
 *   keepImage is true (width = imageWidth, all-or-nothing).  When keepImage
 *   is false they are silently dropped.
 * - Everything else is stripped of HTML → TextSegment.
 *
 * @param {string} html
 * @param {boolean} keepImage
 * @returns {(TextSegment|EmojiSegment|LinkSegment)[]}
 */
function parseInlineContent(html, keepImage) {
  // Step 1 — extract inline spoiler <span> wrappers so the inner content
  //          is still parsed for emoji / images but the spoiler boundary
  //          is tracked as a structured segment.
  const { processedHtml, spoilerBlocks } = extractInlineSpoilers(
    html,
    keepImage
  );

  // Step 2 — parse the remaining HTML (with placeholders) for <img> tags
  const segments = [];
  const imgRegex = /<img\b[^>]*>/gi;
  let lastIndex = 0;
  let match;

  while ((match = imgRegex.exec(processedHtml)) !== null) {
    // Plain HTML before this <img>
    if (match.index > lastIndex) {
      const text = extractTextFromHtml(
        processedHtml.slice(lastIndex, match.index)
      );
      if (text) {
        segments.push({ type: "text", text });
      }
    }

    const tag = match[0];
    if (/class="[^"]*emoji[^"]*"/i.test(tag)) {
      const altMatch = /alt="([^"]*)"[^>]*/i.exec(tag);
      segments.push({ type: "emoji", text: altMatch ? altMatch[1] : "" });
    } else if (keepImage) {
      // Standalone <img> not wrapped in <a> — preserve as image.
      const altMatch = /alt="([^"]*)"[^>]*/i.exec(tag);
      const srcMatch = /src="([^"]*)"[^>]*/i.exec(tag);
      const alt = altMatch?.[1]?.trim() || "image";
      const src = buildUploadShortUrl(tag) || srcMatch?.[1] || "";
      if (src) {
        segments.push({
          type: "link",
          text: alt,
          href: src,
          isBareLink: false,
          isImage: true,
        });
      }
    }
    // When keepImage is false, non-emoji <img> is silently dropped.

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last <img>
  if (lastIndex < processedHtml.length) {
    const text = extractTextFromHtml(processedHtml.slice(lastIndex));
    if (text) {
      segments.push({ type: "text", text });
    }
  }

  // Step 3 — replace placeholder text segments with real spoiler segments
  return injectSpoilerSegments(segments, spoilerBlocks);
}

// ── Image detection helpers ───────────────────────────────────────────────

/**
 * Check whether a link's inner HTML contains an <img> that is NOT an emoji.
 * Discourse lightbox/onebox images are always wrapped in <a>, and we want to
 * exclude inline emoji images (which also live inside <a> tags).
 */
function linkContainsNonEmojiImage(innerHtml) {
  return (
    /<img\b[^>]*>/i.test(innerHtml) &&
    !/class="[^"]*emoji[^"]*"/i.test(innerHtml)
  );
}

/**
 * Extract a human-readable title for the image markdown.
 * Priority: <img alt>  >  <a title>  >  "image" (fallback)
 */
function extractImageTitle(fullATag, innerHtml) {
  const altMatch = /<img[^>]*alt="([^"]*)"[^>]*>/i.exec(innerHtml);
  if (altMatch?.[1]?.trim()) {
    return altMatch[1].trim();
  }
  const titleMatch = /title="([^"]*)"[^>]*>/i.exec(fullATag);
  if (titleMatch?.[1]?.trim()) {
    return titleMatch[1].trim();
  }
  return "image";
}

/**
 * Build a Discourse short-upload URL from an <img> tag's data-base62-sha1
 * and the file extension from its src attribute.
 *
 * Discourse resolves upload://<sha1>.<ext> to the appropriate thumbnail /
 * original automatically, and the link is portable across instances.
 *
 * @param {string} imgTag - the raw <img ...> HTML string
 * @returns {string|null}  e.g. "upload://x0zfA900hmgChpPPlYmsc1mSyvM.jpeg"
 */
function buildUploadShortUrl(imgTag) {
  const sha1Match = /data-base62-sha1="([^"]*)"[^>]*/i.exec(imgTag);
  if (!sha1Match?.[1]) {
    return null;
  }
  const sha1 = sha1Match[1];

  const srcMatch = /src="([^"]*)"[^>]*/i.exec(imgTag);
  if (!srcMatch?.[1]) {
    return null;
  }

  // Pick the last dot-extension before any ? or # or end-of-string
  const extMatch = /\.(\w+)(?:[?#]|$)/i.exec(srcMatch[1]);
  const ext = extMatch?.[1]?.toLowerCase() || "";

  return ext ? "upload://" + sha1 + "." + ext : "upload://" + sha1;
}

// ── Visual-width helpers (double-width Unicode) ───────────────────────────

/*
 * Printable ASCII (0x20–0x7E) → 1
 * Control chars / DEL (≤ 0x7F) → 0
 * Everything else (non-ASCII)   → 2
 */
function charWidth(char) {
  const code = char.codePointAt(0);
  if (code >= 0x20 && code <= 0x7e) {
    return 1;
  }
  if (code <= 0x7f) {
    return 0;
  }
  return 2;
}

function visualWidth(text) {
  let width = 0;
  for (const char of text) {
    width += charWidth(char);
  }
  return width;
}

function sliceByVisualWidth(text, maxWidth) {
  let width = 0;
  let i = 0;
  for (const char of text) {
    const cw = charWidth(char);
    if (cw === 0) {
      i++;
      continue;
    }
    if (width + cw > maxWidth) {
      break;
    }
    width += cw;
    i++;
  }
  return text.slice(0, i);
}

// ── Spoiler helpers ─────────────────────────────────────────────────────────
// Spoiler HTML wrappers are extracted BEFORE the main parsing pass so the
// inner content is still processed for links / images / emoji, but the
// spoiler boundary is tracked as a structured segment.  This lets truncation
// keep the [spoiler]…[/spoiler] BBCode wrapper intact.

const SPOILER_PLACEHOLDER_PREFIX = "\x01SPOILER_";
const SPOILER_PLACEHOLDER_SUFFIX = "\x01";

/**
 * Find every top-level <div class="spoiled …">…</div> block in *html*,
 * replace each with a text placeholder, and recursively parse the inner
 * HTML.  Returns the processed HTML and the collected spoiler-block
 * descriptors so {@link injectSpoilerSegments} can re-insert them later.
 */
function extractBlockSpoilers(html, keepImage) {
  const spoilerStartRe =
    /<div\b[^>]*\bclass="[^"]*\b(?:spoiler|spoiled)\b[^"]*"[^>]*>/gi;

  const blocks = [];
  let output = "";
  let lastIndex = 0;
  let counter = 0;
  let match;

  while ((match = spoilerStartRe.exec(html)) !== null) {
    output += html.slice(lastIndex, match.index);

    // Count <div> / </div> depth to find the matching closing tag
    let depth = 1;
    let searchPos = match.index + match[0].length;
    const divTagRe = /<div\b[^>]*>|<\/div>/gi;
    let found = false;

    while (depth > 0 && searchPos < html.length) {
      divTagRe.lastIndex = searchPos;
      const tagMatch = divTagRe.exec(html);

      if (!tagMatch) {
        break; // malformed HTML — give up
      }

      if (tagMatch[0].startsWith("</div")) {
        depth--;
        if (depth === 0) {
          const innerHtml = html.slice(
            match.index + match[0].length,
            tagMatch.index
          );
          // Recursively parse inner content (may itself contain spoilers)
          const innerSegments = parseHtmlContent(innerHtml, keepImage);
          const placeholder =
            SPOILER_PLACEHOLDER_PREFIX + counter + SPOILER_PLACEHOLDER_SUFFIX;
          blocks.push({ placeholder, segments: innerSegments });
          output += placeholder;
          found = true;
        }
      } else {
        depth++;
      }

      searchPos = tagMatch.index + tagMatch[0].length;
    }

    if (!found) {
      // Couldn't find matching </div> — keep the original text unchanged
      output += html.slice(match.index, searchPos);
    }

    lastIndex = searchPos;
    // Prevent re-scanning already-consumed nested spoilers
    spoilerStartRe.lastIndex = searchPos;
    counter++;
  }

  output += html.slice(lastIndex);
  return { processedHtml: output, spoilerBlocks: blocks };
}

/**
 * Replace inline <span class="spoiler">…</span> wrappers with text
 * placeholders.  Inline spoilers cannot nest, so a simple regex suffices.
 */
function extractInlineSpoilers(html, keepImage) {
  const blocks = [];
  let counter = 0;

  const processedHtml = html.replace(
    /<span\b[^>]*\bclass="[^"]*\b(?:spoiler|spoiled)\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    (_match, innerHtml) => {
      const placeholder =
        SPOILER_PLACEHOLDER_PREFIX + counter + SPOILER_PLACEHOLDER_SUFFIX;
      const innerSegments = parseInlineContent(innerHtml, keepImage);
      blocks.push({ placeholder, segments: innerSegments });
      counter++;
      return placeholder;
    }
  );

  return { processedHtml, spoilerBlocks: blocks };
}

/**
 * Walk through *segments* and replace every text segment whose content
 * matches a spoiler placeholder with a `{ type: "spoiler", segments }`
 * segment.  Placeholders are single-word tokens, so they survive
 * `extractTextFromHtml` intact.
 */
function injectSpoilerSegments(segments, spoilerBlocks) {
  if (spoilerBlocks.length === 0) {
    return segments;
  }

  const result = [];
  for (const seg of segments) {
    if (seg.type !== "text") {
      result.push(seg);
      continue;
    }

    let text = seg.text;
    let found = false;

    for (const block of spoilerBlocks) {
      const idx = text.indexOf(block.placeholder);
      if (idx < 0) {
        continue;
      }

      found = true;
      // Text before the placeholder
      if (idx > 0) {
        const before = text.substring(0, idx).trim();
        if (before) {
          result.push({ type: "text", text: before });
        }
      }

      // The spoiler block itself
      result.push({ type: "spoiler", segments: block.segments });

      // Continue with text after the placeholder (may contain more
      // placeholders)
      text = text.substring(idx + block.placeholder.length);
    }

    if (found && text.trim()) {
      result.push({ type: "text", text: text.trim() });
    } else if (!found) {
      result.push(seg);
    }
  }

  return result;
}

/**
 * Parse raw HTML (NO surrounding [quote]…[/quote] wrapper) into structured
 * segments.  This is the core parsing routine — it extracts spoiler blocks
 * and <a> links, leaving the remainder as text/emoji/image segments.
 */
function parseHtmlContent(html, keepImage) {
  // Step 1 — extract block spoilers so their inner content is parsed
  //          normally but the spoiler boundary is tracked.
  const { processedHtml, spoilerBlocks } = extractBlockSpoilers(
    html,
    keepImage
  );

  // Step 2 — parse the remaining HTML (with placeholders) for links
  const segments = [];
  const linkRegex = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(processedHtml)) !== null) {
    // Plain text before this link — may produce text + emoji segments
    if (match.index > lastIndex) {
      const beforeSegments = parseInlineContent(
        processedHtml.slice(lastIndex, match.index),
        keepImage
      );
      segments.push(...beforeSegments);
    }

    const href = match[1];
    const innerHtml = match[2];

    if (keepImage && linkContainsNonEmojiImage(innerHtml)) {
      const imageHref = buildUploadShortUrl(innerHtml) || href;
      segments.push({
        type: "link",
        text: extractImageTitle(match[0], innerHtml),
        href: imageHref,
        isBareLink: false,
        isImage: true,
      });
    } else {
      const innerSegments = parseInlineContent(innerHtml, keepImage);
      const displayText = innerSegments.map((s) => s.text).join("");

      if (displayText) {
        const isBareLink =
          displayText.toLowerCase() === href.trim().toLowerCase();
        segments.push({
          type: "link",
          text: displayText,
          href,
          isBareLink,
        });
      }
    }

    lastIndex = linkRegex.lastIndex;
  }

  // Remaining text after the last link
  if (lastIndex < processedHtml.length) {
    const afterSegments = parseInlineContent(
      processedHtml.slice(lastIndex),
      keepImage
    );
    segments.push(...afterSegments);
  }

  // Step 3 — replace placeholder text segments with real spoiler segments
  return injectSpoilerSegments(segments, spoilerBlocks);
}

/**
 * Parse a buildQuote BBCode string into prefix, suffix, and an array of
 * structured segments.
 *
 * @returns {{ prefix: string, suffix: string, segments: Array }}
 */
function parseHtmlToSegments(bbcodeString, keepImage) {
  const contentStart = bbcodeString.indexOf("]\n") + 2;
  const contentEnd = bbcodeString.lastIndexOf("\n[/quote]");

  const prefix = bbcodeString.substring(0, contentStart);
  const suffix = bbcodeString.substring(contentEnd);
  const htmlContent = bbcodeString.substring(contentStart, contentEnd);

  const segments = parseHtmlContent(htmlContent, keepImage);
  return { prefix, suffix, segments };
}

/**
 * For bare links (display text === href), proactively truncate the display
 * text after the first URL path segment so long URLs don't dominate the quote.
 *
 * e.g. https://example.com/info/1035/13639.htm
 *   → display text: https://example.com/info/...
 *   → href stays:   https://example.com/info/1035/13639.htm
 */
function proactivelyTruncateBareLinks(segments) {
  return segments.map((seg) => {
    if (seg.type !== "link" || !seg.isBareLink) {
      return seg;
    }

    try {
      const parsed = new URL(seg.href);
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      if (pathParts.length > 0) {
        const truncatedText = parsed.origin + "/" + pathParts[0] + "/...";
        // Only apply if it actually shortens the text
        if (truncatedText.length < seg.text.length) {
          return {
            ...seg,
            text: truncatedText,
            isBareLink: false, // no longer bare after truncation
            truncated: true, // marks that "..." is already appended
          };
        }
      }
    } catch {
      // If URL parsing fails, leave the segment unchanged
    }

    return seg;
  });
}

/**
 * Total number of display characters across all segments.
 * Only display text counts — link hrefs are NOT counted.
 */
function computeSegmentsDisplayLength(segments, doubleWidth, imageWidth) {
  return segments.reduce((total, seg) => {
    if (seg.type === "emoji") {
      return total + 2; // emoji visual width ≈ 2 ASCII chars
    }
    if (seg.type === "spoiler") {
      // Spoiler BBCode wrapper adds no visual width — only count inner content.
      return total + computeSegmentsDisplayLength(seg.segments, doubleWidth, imageWidth);
    }
    if (seg.isImage) {
      return total + imageWidth;
    }
    const w = doubleWidth ? visualWidth(seg.text) : seg.text.length;
    return total + w;
  }, 0);
}

/**
 * Smart truncation: iterate through segments, accumulating display characters.
 * When the limit is exceeded the current segment's TEXT is truncated but link
 * hrefs are kept intact.
 *
 * When doubleWidth is true, CJK / fullwidth characters count as 2 so that
 * mixed Chinese-English text has a more consistent visual cut point.
 */
function truncateSegments(segments, charLimit, doubleWidth, imageWidth) {
  const result = [];
  let accumulated = 0;

  for (const seg of segments) {
    const remaining = charLimit - accumulated;
    if (remaining <= 0) {
      break;
    }

    if (seg.type === "emoji") {
      // Emoji are all-or-nothing with width 2 (visual width ≈ 2 ASCII chars).
      if (accumulated + 2 <= charLimit) {
        result.push(seg);
        accumulated += 2;
      }
      continue;
    }

    if (seg.type === "spoiler") {
      // Spoiler segments keep their BBCode wrapper intact.
      // Inner content is truncated if needed; the wrapper itself costs
      // no display width.
      const innerLen = computeSegmentsDisplayLength(
        seg.segments,
        doubleWidth,
        imageWidth
      );
      if (innerLen <= remaining) {
        // Entire spoiler fits
        result.push(seg);
        accumulated += innerLen;
      } else {
        // Spoiler too long — truncate inner content but keep the wrapper
        const truncatedInner = truncateSegments(
          seg.segments,
          remaining,
          doubleWidth,
          imageWidth
        );
        if (truncatedInner.length > 0) {
          result.push({ type: "spoiler", segments: truncatedInner });
          accumulated += computeSegmentsDisplayLength(
            truncatedInner,
            doubleWidth,
            imageWidth
          );
        }
      }
      continue;
    }

    if (seg.isImage) {
      // Images are all-or-nothing: keep whole if the fixed width fits,
      // otherwise drop entirely (no partial image markdown).
      if (accumulated + imageWidth <= charLimit) {
        result.push(seg);
        accumulated += imageWidth;
      }
      continue;
    }

    const segWidth = doubleWidth ? visualWidth(seg.text) : seg.text.length;

    if (seg.type === "text") {
      if (accumulated + segWidth <= charLimit) {
        result.push(seg);
        accumulated += segWidth;
      } else if (
        seg.truncated &&
        accumulated + segWidth - 3 <= charLimit
      ) {
        // Pre-truncated segment: its own "..." acts as the truncation marker.
        // Accept it whole, overshooting the limit slightly.
        result.push(seg);
        accumulated += segWidth;
      } else {
        const cutText = doubleWidth
          ? sliceByVisualWidth(seg.text, remaining)
          : seg.text.substring(0, remaining);
        result.push({
          type: "text",
          text: cutText + "...",
        });
        accumulated = charLimit;
      }
    } else {
      // link segment — only truncate display text, keep href intact
      if (accumulated + segWidth <= charLimit) {
        result.push(seg);
        accumulated += segWidth;
      } else if (
        seg.truncated &&
        accumulated + segWidth - 3 <= charLimit
      ) {
        // Pre-truncated link: use its own "..." as the ending marker
        result.push(seg);
        accumulated += segWidth;
      } else {
        const cutText = doubleWidth
          ? sliceByVisualWidth(seg.text, remaining)
          : seg.text.substring(0, remaining);
        result.push({
          ...seg,
          text: cutText + "...",
          isBareLink: false,
        });
        accumulated = charLimit;
      }
    }
  }

  return result;
}

/**
 * Check whether a segment array (recursively) contains any user-uploaded
 * image.  Emoji images (type "emoji") do NOT count.
 */
function containsUploadedImage(segments) {
  return segments.some(
    (s) => s.isImage || (s.type === "spoiler" && containsUploadedImage(s.segments))
  );
}

/**
 * Recursively split user-uploaded images out of spoiler blocks so each image
 * gets its own [spoiler] wrapper.  This is required by the Discourse backend:
 * image-only [spoiler] blocks must be separated from inline text by a newline
 * for the blur to render correctly on the server side.
 *
 * Returns a new segment array with images extracted into dedicated spoiler
 * blocks.
 */
function splitImagesFromSpoilers(segments) {
  const result = [];
  for (const seg of segments) {
    if (seg.type !== "spoiler") {
      result.push(seg);
      continue;
    }

    // Partition inner segments: images vs everything else
    const images = [];
    const others = [];
    for (const inner of seg.segments) {
      if (inner.isImage) {
        images.push(inner);
      } else if (inner.type === "spoiler") {
        // Recurse into nested spoilers, then split any images found
        const processed = splitImagesFromSpoilers([inner]);
        for (const p of processed) {
          if (p.type === "spoiler" && p.segments.every((s) => s.isImage)) {
            images.push(...p.segments);
          } else {
            others.push(p);
          }
        }
      } else {
        others.push(inner);
      }
    }

    // Emit text-only spoiler (if any non-image content remains)
    if (others.length > 0) {
      result.push({ type: "spoiler", segments: others });
    }
    // Each image gets its own dedicated spoiler block
    for (const img of images) {
      result.push({ type: "spoiler", segments: [img] });
    }
  }
  return result;
}

/**
 * Rebuild the final content string from segments.
 * Links are output as Markdown [text](url) so they stay clickable.
 */
function segmentsToContent(segments) {
  return segments
    .map((seg) => {
      if (seg.type === "emoji") {
        return seg.text;
      }
      if (seg.type === "text") {
        return seg.text;
      }
      if (seg.type === "spoiler") {
        const inner = segmentsToContent(seg.segments);
        // Image-only spoiler blocks must sit on their own line — the
        // Discourse backend only renders the blur correctly when an
        // image [spoiler] is separated from adjacent text by a newline.
        if (containsUploadedImage(seg.segments)) {
          return "\n[spoiler]" + inner + "[/spoiler]\n";
        }
        return "[spoiler]" + inner + "[/spoiler]";
      }
      if (seg.isImage) {
        return "![" + seg.text + "](" + seg.href + ")";
      }
      // link
      return "[" + seg.text + "](" + seg.href + ")";
    })
    .join(" ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/**
 * Flatten segments to plain text, preserving [spoiler] BBCode wrappers
 * so that hidden content stays hidden even in the blunt-truncation path.
 */
function segmentsToFlatText(segments) {
  return segments
    .map((seg) => {
      if (seg.type === "spoiler") {
        return "[spoiler]" + segmentsToFlatText(seg.segments) + "[/spoiler]";
      }
      return seg.text;
    })
    .join(" ");
}

/**
 * Unified pipeline: parse → optionally truncate bare links → optionally apply
 * truncation → reconstruct. Returns the final quotedText string.
 *
 * When keep_link_reachable is ON, links are output as [text](url) and only
 * display text is truncated.  When OFF, links become plain text and truncation
 * is a blunt substring cut on the flattened text.
 */
function processQuoteWithSegments(bbcodeString, settings) {
  // Always strip nested quotes first
  let text = bbcodeString.replace(/<aside[\s\S]*<\/aside>/g, "");

  // Parse into structured segments.
  // Spoiler blocks are detected here and become { type: "spoiler", segments }
  // so they survive truncation with the [spoiler]…[/spoiler] wrapper intact.
  let { prefix, suffix, segments } = parseHtmlToSegments(
    text,
    settings.quick_quote_keep_image
  );

  const doubleWidth = settings.quick_quote_double_width_unicode;
  const imageWidth = settings.quick_quote_image_character_width;

  // Bare-link truncation requires keep_link_reachable to be ON first
  if (
    settings.quick_quote_keep_link_reachable &&
    settings.quick_quote_truncate_bare_links
  ) {
    segments = proactivelyTruncateBareLinks(segments);
  }

  // Character limit
  if (settings.quick_quote_character_limit) {
    const displayLength = computeSegmentsDisplayLength(segments, doubleWidth, imageWidth);
    if (displayLength > settings.quick_quote_character_limit) {
      if (settings.quick_quote_keep_link_reachable) {
        // Smart truncation: only shorten display text, keep hrefs intact.
        // Spoiler wrappers are preserved, inner content is truncated.
        segments = truncateSegments(
          segments,
          settings.quick_quote_character_limit,
          doubleWidth,
          imageWidth
        );
      } else {
        // Blunt truncation: flatten to text (preserving [spoiler] BBCode),
        // then cut by visual width.
        const flatText = segmentsToFlatText(segments);
        const excerpt = doubleWidth
          ? sliceByVisualWidth(flatText, settings.quick_quote_character_limit)
          : flatText.substring(0, settings.quick_quote_character_limit);
        return prefix + excerpt + "..." + suffix;
      }
    }
  }

  // Split user-uploaded images out of spoiler blocks so each image gets
  // its own [spoiler] on its own line.  The Discourse backend only renders
  // the blur correctly when an image [spoiler] is separated from adjacent
  // text by a newline.
  if (settings.quick_quote_keep_image) {
    segments = splitImagesFromSpoilers(segments);
  }

  // Reconstruct
  let content;
  if (settings.quick_quote_keep_link_reachable) {
    // Links as [text](url) so they stay clickable.
    // Spoilers as [spoiler]…[/spoiler] BBCode.
    content = segmentsToContent(segments);
  } else {
    // Plain text only — no Markdown link syntax, but spoiler BBCode kept.
    content = segmentsToFlatText(segments);
  }

  return prefix + content + suffix;
}

export default {
  name: "quick-quote-edits",
  initialize() {
    withPluginApi((api) => {
      api.modifyClass(
        "controller:topic",
        (Superclass) =>
          class extends Superclass {
            @action
            replyToPost(post) {
              const composerController = this.composer;
              const topic = post ? post.get("topic") : this.model;
              const quoteState = this.quoteState;
              const postStream = this.get("model.postStream");

              this.appEvents.trigger("page:compose-reply", topic);

              if (
                !postStream ||
                !topic ||
                !topic.get("details.can_create_post")
              ) {
                return;
              }

              let quotedText = "";

              if (quoteState.buffer === "" || quoteState.buffer === undefined) {
                if (post) {
                  if (
                    post.post_number !== 1 &&
                    topic.highest_post_number + 1 - post.post_number >
                    settings.quick_quote_post_location_threshold
                  ) {
                    quotedText = buildQuote(post, post.cooked);
                    quotedText = processQuoteWithSegments(quotedText, settings);
                  }
                }
              } else {
                const quotedPost = postStream.findLoadedPost(quoteState.postId);
                quotedText = buildQuote(
                  quotedPost,
                  quoteState.buffer,
                  quoteState.opts
                );
              }

              quoteState.clear();

              if (
                composerController.get("model.topic.id") === topic.get("id") &&
                composerController.get("model.action") === Composer.REPLY
              ) {
                composerController.set("model.post", post);
                composerController.set("model.composeState", Composer.OPEN);
                this.appEvents.trigger(
                  "composer:insert-block",
                  quotedText.trim()
                );
              } else {
                const opts = {
                  action: Composer.REPLY,
                  draftKey: topic.get("draft_key"),
                  draftSequence: topic.get("draft_sequence"),
                };

                if (quotedText) {
                  opts.quote = quotedText;
                }

                if (post && post.get("post_number") !== 1) {
                  opts.post = post;
                } else {
                  opts.topic = topic;
                }

                composerController.open(opts);
              }
              return false;
            }
          }
      );
    });
  },
};
