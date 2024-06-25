import prompts from "prompts";

export const getPlatform = async () => {
  const response = await prompts([
    {
      type: "select",
      name: "platfrom",
      message: "Which platform do you want to deploy?",
      choices: [
        { title: "ios", value: "ios" },
        { title: "android", value: "android" },
      ],
    },
  ]);
  return response.platfrom;
};
