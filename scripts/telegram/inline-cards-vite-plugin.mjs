import { readKnowledgeBase } from "../catalogue/query.mjs";
import { generateInlineCards } from "./inline-card-renderer.mjs";

export function inlineCardsPlugin(root) {
  return {
    name: "telegram-inline-cards",
    apply: "build",
    async buildStart() {
      const knowledgeBase = readKnowledgeBase(root);
      const cards = await generateInlineCards(knowledgeBase, root);
      for (const card of cards) {
        this.emitFile({
          type: "asset",
          fileName: `inline-cards/${card.filename}`,
          source: card.buffer,
        });
      }
    },
  };
}
