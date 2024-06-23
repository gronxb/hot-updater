import prompts from "prompts";

export const getPlatform = async () => {
  const response = await prompts([
    {
      type: "select",
      name: "platfrom",
      message: "Which platform do you want to deploy?",
      choices: [
        { title: "ios", value: "#00ff00" },
        { title: "android", value: "#00ff00" },
      ],
    },
  ]);
  return response.platfrom;
};
