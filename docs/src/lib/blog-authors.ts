// Add authors here, then use their key in a post's author frontmatter.
export const blogAuthors = {
  gronxb: {
    name: "gronxb",
    githubUrl: "https://github.com/gronxb",
    avatarUrl: "https://avatars.githubusercontent.com/u/41789633?v=4&s=80",
  },
};

export type BlogAuthorId = keyof typeof blogAuthors;
