// Run the cost plugin's Vultr fetcher against a real account and print what the
// board row would carry, plus the raw line items so their field names can be
// checked. Prompts for the API key without echo; it is not written anywhere.
//
//   bun scripts/try-vultr.ts
import { createInterface } from "node:readline"
import { collectCost } from "../plugins/monitoring/CostPlugin.ts"

const ask = (q: string) => new Promise<string>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true }) as any
  rl._writeToOutput = (s: string) => { if (s.includes(q)) process.stdout.write(s) }
  rl.question(q, (a: string) => { rl.close(); process.stdout.write("\n"); resolve(a.trim()) })
})
const apiKey = await ask("Vultr API key (not shown): ")

const raw = await fetch("https://api.vultr.com/v2/billing/pending-charges", { headers: { Authorization: `Bearer ${apiKey}` } })
console.log("pending-charges", raw.status, "first 3 line items:")
console.log(JSON.stringify(((await raw.json()) as any).pending_charges?.slice(0, 3), null, 2))

console.log("\nrow:")
console.log(JSON.stringify(await collectCost({ provider: "vultr", apiKey }), null, 2))
