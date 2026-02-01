import { action } from "@ember/object";
import { withPluginApi } from "discourse/lib/plugin-api";
import { buildQuote } from "discourse/lib/quote";
import Composer from "discourse/models/composer";

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

                    if (settings.quick_quote_save_link_text) {
                      quotedText = quotedText.replace(/<a\b[^>]*>(.*?)<\/a>/gi, " $1 ");
                    }
                    const startOfQuoteText = quotedText.indexOf("]") + 2; // not forgetting the new line char
                    const lengthOfEndQuoteTag = 11; // [/quote] and newline preceeding
                    let startOfExcerpt = startOfQuoteText;
                    let excerpt = "";
                    if (settings.quick_quote_remove_contiguous_new_lines) {
                      excerpt = quotedText.substring(
                        startOfExcerpt,
                        quotedText.length - lengthOfEndQuoteTag
                      );
                      excerpt = excerpt.replace(/\n*\n/g, "");
                      quotedText =
                        quotedText.substring(0, startOfQuoteText) +
                        excerpt +
                        quotedText.substring(
                          quotedText.length - lengthOfEndQuoteTag,
                          quotedText.length
                        );
                    }
                    quotedText = quotedText.replace(/<[^>]*>/g, " "); // 始终移除所有 HTML 标签
                    if (settings.quick_quote_character_limit) {
                      const contentStart = startOfQuoteText;
                      const contentEnd = quotedText.length - lengthOfEndQuoteTag;
                      const actualContentLength = contentEnd - contentStart;

                      if (actualContentLength > settings.quick_quote_character_limit) {
                        const excerpt = quotedText.substring(
                          contentStart,
                          contentStart + settings.quick_quote_character_limit
                        );

                        quotedText =
                          quotedText.substring(0, contentStart) +
                          excerpt +
                          "..." +
                          quotedText.substring(contentEnd);
                      }
                    }
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
