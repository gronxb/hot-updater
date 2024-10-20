import { wrap } from "@typeschema/valibot";
import { string } from "valibot";
import { createTRPCRouter, publicProcedure } from "../utils";

export const hotUpdaterRouter = createTRPCRouter({
  hello: publicProcedure.input(wrap(string())).query(({ input }) => {
    return `Hello ${input}!`;
  }),
});
