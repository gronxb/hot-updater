import * as p from "@clack/prompts";

export const rollback = async () => {
  const group = await p.group({
    platform: () =>
      p.select({
        initialValue: "ios",
        message: "Select platform to rollback",
        options: [
          { label: "ios", value: "ios" },
          { label: "android", value: "android" },
        ],
      }),
    versions: () =>
      p.multiselect({
        message: "Select versions to rollback.",
        options: [
          { label: "17130291", value: "17130291" },
          { label: "17130292", value: "17130292" },
          { label: "17130293", value: "17130293" },
        ],
        required: true,
      }),
  });

  console.log(group);
};
