// Code tools: they run inside the relay, so they can use any npm package and
// any secret in the relay's environment. Named by "toolsModule" in
// assistant.config.json.
//
// This file sits two folders below the relay checkout, hence "../../server/...".
// In your own project, put it in the checkout root beside assistant.config.json and
// import "./server/tools/index" instead (the helpers only add type checking).
import { defineTool, defineTools } from "../../server/tools/index";

const INVENTORY: Record<string, { price: number; inStock: number }> = {
  "trail runner 2": { price: 129, inStock: 14 },
  "summit 40 backpack": { price: 189, inStock: 0 },
  "storm shell jacket": { price: 249, inStock: 6 }
};

export default defineTools([
  defineTool<{ product: string }>({
    name: "check_stock",
    description: "Check the price and how many are in stock for a product in the Acme Outdoor catalogue.",
    parameters: {
      type: "object",
      properties: { product: { type: "string", description: "Product name, e.g. Trail Runner 2." } },
      required: ["product"]
    },
    handler({ product }, context) {
      context.log.info("stock lookup", { product });
      const item = INVENTORY[String(product).toLowerCase().trim()];
      if (!item) return { found: false, catalogue: Object.keys(INVENTORY) };
      return { found: true, product, priceUsd: item.price, inStock: item.inStock };
    }
  })
]);
