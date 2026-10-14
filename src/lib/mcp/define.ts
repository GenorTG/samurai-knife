import * as z from "zod/v4";

/** Who is calling. Stateless tools ignore it; account-scoped tools (CV studio) require it. */
export interface KnifeToolContext {
  accountId: string;
}

export interface KnifeToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  execute(input: unknown, ctx?: KnifeToolContext): Promise<unknown>;
}

export function defineTool<Schema extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: Schema;
  run(input: z.output<Schema>, ctx?: KnifeToolContext): unknown | Promise<unknown>;
}): KnifeToolDefinition {
  return {
    name: options.name,
    description: options.description,
    schema: options.schema,
    async execute(input, ctx) {
      const parsed = options.schema.safeParse(input);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
      }
      return options.run(parsed.data, ctx);
    },
  };
}
