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
 * @typedef {Object} LinkSegment
 * @property {"link"} type
 * @property {string} text   - display text (textContent of <a>)
 * @property {string} href   - full URL
 * @property {boolean} isBareLink - text === href
 */

/**
 * Strip HTML tags and normalise whitespace from a raw HTML fragment.
 */
function extractTextFromHtml(html) {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
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
function parseHtmlToSegments(bbcodeString) {
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
    // Plain text before this link
    if (match.index > lastIndex) {
      const beforeText = extractTextFromHtml(
        htmlContent.slice(lastIndex, match.index)
      );
      if (beforeText) {
        segments.push({ type: "text", text: beforeText });
      }
    }

    const href = match[1];
    const innerHtml = match[2];
    const displayText = extractTextFromHtml(innerHtml);

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

    lastIndex = linkRegex.lastIndex;
  }

  // Remaining text after the last link
  if (lastIndex < htmlContent.length) {
    const afterText = extractTextFromHtml(htmlContent.slice(lastIndex));
    if (afterText) {
      segments.push({ type: "text", text: afterText });
    }
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
function computeSegmentsDisplayLength(segments, doubleWidth) {
  return segments.reduce((total, seg) => {
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
function truncateSegments(segments, charLimit, doubleWidth) {
  const result = [];
  let accumulated = 0;

  for (const seg of segments) {
    const remaining = charLimit - accumulated;
    if (remaining <= 0) {
      break;
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
      if (seg.type === "text") {
        return seg.text;
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
  let { prefix, suffix, segments } = parseHtmlToSegments(text);

  const doubleWidth = settings.quick_quote_double_width_unicode;

  // Bare-link truncation requires keep_link_reachable to be ON first
  if (
    settings.quick_quote_keep_link_reachable &&
    settings.quick_quote_truncate_bare_links
  ) {
    segments = proactivelyTruncateBareLinks(segments);
  }

  // Character limit
  if (settings.quick_quote_character_limit) {
    const displayLength = computeSegmentsDisplayLength(segments, doubleWidth);
    if (displayLength > settings.quick_quote_character_limit) {
      if (settings.quick_quote_keep_link_reachable) {
        // Smart truncation: only shorten display text, keep hrefs intact
        segments = truncateSegments(
          segments,
          settings.quick_quote_character_limit,
          doubleWidth
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
