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
  const segments = [];
  const imgRegex = /<img\b[^>]*>/gi;
  let lastIndex = 0;
  let match;

  while ((match = imgRegex.exec(html)) !== null) {
    // Plain HTML before this <img>
    if (match.index > lastIndex) {
      const text = extractTextFromHtml(html.slice(lastIndex, match.index));
      if (text) {
        segments.push({ type: "text", text });
      }
    }

    const tag = match[0];
    if (/class="[^"]*emoji[^"]*"/i.test(tag)) {
      const altMatch = /alt="([^"]*)"[^>]*/i.exec(tag);
      segments.push({ type: "emoji", text: altMatch ? altMatch[1] : "" });
    } else if (keepImage) {
      // Standalone <img> not wrapped in <a> — preserve as image
      const altMatch = /alt="([^"]*)"[^>]*/i.exec(tag);
      const srcMatch = /src="([^"]*)"[^>]*/i.exec(tag);
      const alt = altMatch?.[1]?.trim() || "image";
      const src = srcMatch?.[1] || "";
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
  if (lastIndex < html.length) {
    const text = extractTextFromHtml(html.slice(lastIndex));
    if (text) {
      segments.push({ type: "text", text });
    }
  }

  return segments;
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

/**
 * Parse a buildQuote BBCode string into prefix, suffix, and an array of
 * structured segments.
 *
 * @returns {{ prefix: string, suffix: string, segments: (TextSegment|LinkSegment)[] }}
 */
function parseHtmlToSegments(bbcodeString, keepImage) {
  const contentStart = bbcodeString.indexOf("]\n") + 2;
  const contentEnd = bbcodeString.length - 11; // "\n[/quote]".length

  const prefix = bbcodeString.substring(0, contentStart);
  const suffix = bbcodeString.substring(contentEnd);
  const htmlContent = bbcodeString.substring(contentStart, contentEnd);

  const segments = [];
  const linkRegex = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(htmlContent)) !== null) {
    // Plain text before this link — may produce text + emoji segments
    if (match.index > lastIndex) {
      const beforeSegments = parseInlineContent(
        htmlContent.slice(lastIndex, match.index),
        keepImage
      );
      segments.push(...beforeSegments);
    }

    const href = match[1];
    const innerHtml = match[2];

    if (keepImage && linkContainsNonEmojiImage(innerHtml)) {
      // Image wrapped in a link (lightbox / onebox / manual) —
      // preserve as a structured image so it can be output as ![title](url)
      segments.push({
        type: "link",
        text: extractImageTitle(match[0], innerHtml),
        href,
        isBareLink: false,
        isImage: true,
      });
    } else {
      // Regular link — flatten inline content to display text.
      // Emoji inside a link contribute their raw alt text (e.g. :wave:)
      // and count toward the display string as literal characters.
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

  // Remaining text after the last link — may produce text + emoji segments
  if (lastIndex < htmlContent.length) {
    const afterSegments = parseInlineContent(htmlContent.slice(lastIndex), keepImage);
    segments.push(...afterSegments);
  }

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
      return total + 1; // emoji always counts as 1 character
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
      // Emoji are all-or-nothing with width 1.
      if (accumulated + 1 <= charLimit) {
        result.push(seg);
        accumulated += 1;
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
      if (seg.isImage) {
        return "![" + seg.text + "](" + seg.href + ")";
      }
      // link
      return "[" + seg.text + "](" + seg.href + ")";
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

  // Parse into structured segments (links are always preserved as objects)
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
        // Smart truncation: only shorten display text, keep hrefs intact
        segments = truncateSegments(
          segments,
          settings.quick_quote_character_limit,
          doubleWidth,
          imageWidth
        );
      } else {
        // Blunt truncation: flatten everything to plain text, then cut
        const flatText = segments.map((seg) => seg.text).join(" ");
        const excerpt = doubleWidth
          ? sliceByVisualWidth(flatText, settings.quick_quote_character_limit)
          : flatText.substring(0, settings.quick_quote_character_limit);
        return prefix + excerpt + "..." + suffix;
      }
    }
  }

  // Reconstruct
  let content;
  if (settings.quick_quote_keep_link_reachable) {
    // Links as [text](url) so they stay clickable
    content = segmentsToContent(segments);
  } else {
    // Plain text only — no Markdown link syntax
    content = segments.map((seg) => seg.text).join(" ");
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
